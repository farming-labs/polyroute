use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use tokio_util::sync::CancellationToken;
use url::Url;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody};

#[derive(Clone)]
struct Rule {
    hostname: String,
    port: Option<String>,
    subdomains: bool,
    any: bool,
}

#[derive(Clone)]
pub struct Policy(Vec<Rule>);

impl Policy {
    pub fn new(entries: &[String]) -> anyhow::Result<Self> {
        let mut rules = Vec::new();
        let mut invalid = Vec::new();
        for entry in entries {
            if entry == "*" {
                rules.push(Rule {
                    hostname: String::new(),
                    port: None,
                    subdomains: false,
                    any: true,
                });
                continue;
            }
            let subdomains = entry.starts_with("*.");
            let host = if subdomains {
                &entry[2..]
            } else {
                entry.as_str()
            };
            if host.is_empty()
                || host.chars().any(|c| {
                    (c.is_whitespace() && c != '\u{0085}')
                        || c == '\u{feff}'
                        || "/?#@\\*".contains(c)
                })
            {
                invalid.push(entry.clone());
                continue;
            }
            let Ok(url) = Url::parse(&format!("http://{host}")) else {
                invalid.push(entry.clone());
                continue;
            };
            let Some(hostname) = url.host_str() else {
                invalid.push(entry.clone());
                continue;
            };
            let port = host.rsplit_once(':').and_then(|(_, suffix)| {
                (!suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
                    .then(|| suffix.to_string())
            });
            rules.push(Rule {
                hostname: hostname.to_owned(),
                port,
                subdomains,
                any: false,
            });
        }
        anyhow::ensure!(
            invalid.is_empty(),
            "invalid outbound allow entries {invalid:?}; use hosts without schemes or paths"
        );
        Ok(Self(rules))
    }

    pub fn allows(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };
        let port = url.port_or_known_default().map(|p| p.to_string());
        self.0.iter().any(|rule| {
            if rule.any {
                return true;
            }
            if rule.port.is_some() && rule.port != port {
                return false;
            }
            if rule.subdomains {
                host.ends_with(&format!(".{}", rule.hostname))
            } else {
                host == rule.hostname
            }
        })
    }
}

pub struct ClientState {
    client: reqwest::Client,
    policy: Policy,
}

impl ClientState {
    pub fn new(entries: &[String]) -> anyhow::Result<Arc<Self>> {
        let policy = Policy::new(entries)?;
        rustls::crypto::ring::default_provider()
            .install_default()
            .map_err(|_| {
                anyhow::anyhow!(
                    "TLS provider was already configured; initialize this private host once"
                )
            })?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .pool_max_idle_per_host(32)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        Ok(Arc::new(Self { client, policy }))
    }
}

#[derive(Clone)]
pub struct OutboundContext {
    pub state: Arc<ClientState>,
    pub cancel: CancellationToken,
}

pub async fn send(
    context: Option<OutboundContext>,
    request: http::Request<WasiBody>,
    options: Option<RequestOptions>,
) -> Result<http::Response<WasiBody>, Error> {
    let context = context.ok_or(Error::HttpRequestDenied)?;
    tokio::select! {
        biased;
        _ = context.cancel.cancelled() => Err(Error::ConnectionTerminated),
        result = send_inner(&context.state, request, options.unwrap_or_default()) => result,
    }
}

fn timer_duration(duration: Duration) -> Duration {
    // Match the existing host's nanosecond conversion and Node timer range.
    let millis = duration.as_millis();
    Duration::from_millis(if millis == 0 || millis > i32::MAX as u128 {
        1
    } else {
        millis as u64
    })
}

async fn send_inner(
    state: &ClientState,
    request: http::Request<WasiBody>,
    options: RequestOptions,
) -> Result<http::Response<WasiBody>, Error> {
    let (parts, body) = request.into_parts();
    let url = Url::parse(&parts.uri.to_string()).map_err(|_| Error::HttpRequestUriInvalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::HttpRequestUriInvalid);
    }
    if !state.policy.allows(&url) {
        return Err(Error::HttpRequestDenied);
    }
    let body = body.collect().await?.to_bytes();
    if !body.is_empty() && matches!(parts.method, http::Method::GET | http::Method::HEAD) {
        return Err(Error::HttpRequestMethodInvalid);
    }
    let mut headers = parts.headers;
    headers.remove(http::header::CONTENT_LENGTH);
    if !headers.contains_key(http::header::ACCEPT_ENCODING) {
        headers.insert(
            http::header::ACCEPT_ENCODING,
            http::HeaderValue::from_static("identity"),
        );
    }
    let request = state
        .client
        .request(parts.method, url)
        .headers(headers)
        .body(body);
    let headers_timeout = match (options.connect_timeout, options.first_byte_timeout) {
        (None, None) => None,
        (connect, first) => Some(
            connect
                .unwrap_or_default()
                .saturating_add(first.unwrap_or_default()),
        ),
    };
    let send = request.send();
    let mut response = if let Some(limit) = headers_timeout {
        tokio::time::timeout(timer_duration(limit), send)
            .await
            .map_err(|_| {
                if options.first_byte_timeout.is_none() {
                    Error::ConnectionTimeout
                } else {
                    Error::ConnectionReadTimeout
                }
            })?
            .map_err(map_error)?
    } else {
        send.await.map_err(map_error)?
    };
    let status = response.status();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    loop {
        let read = response.chunk();
        let chunk = if let Some(limit) = options.between_bytes_timeout {
            tokio::time::timeout(timer_duration(limit), read)
                .await
                .map_err(|_| Error::ConnectionReadTimeout)?
                .map_err(map_error)?
        } else {
            read.await.map_err(map_error)?
        };
        let Some(chunk) = chunk else {
            break;
        };
        bytes.extend_from_slice(&chunk);
    }
    let mut result = http::Response::builder().status(status);
    *result
        .headers_mut()
        .ok_or_else(|| Error::InternalError(Some("invalid outbound status".into())))? = headers;
    result
        .body(
            Full::new(Bytes::from(bytes))
                .map_err(Error::from)
                .boxed_unsync(),
        )
        .map_err(|error| Error::InternalError(Some(error.to_string())))
}

fn map_error(error: reqwest::Error) -> Error {
    if error.is_dns() {
        return if error.is_timeout() {
            Error::DnsTimeout
        } else {
            Error::DnsError {
                rcode: None,
                info_code: None,
            }
        };
    }
    if error.is_timeout() {
        return Error::ConnectionTimeout;
    }
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            let mapped = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => Some(Error::ConnectionRefused),
                std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof => Some(Error::ConnectionTerminated),
                std::io::ErrorKind::TimedOut => Some(Error::ConnectionTimeout),
                std::io::ErrorKind::HostUnreachable | std::io::ErrorKind::NetworkUnreachable => {
                    Some(Error::DestinationUnavailable)
                }
                _ => None,
            };
            if let Some(mapped) = mapped {
                return mapped;
            }
            source = io
                .get_ref()
                .map(|inner| inner as &(dyn std::error::Error + 'static));
            continue;
        }
        if let Some(http) = cause.downcast_ref::<hyper::Error>()
            && (http.is_closed() || http.is_incomplete_message())
        {
            return Error::ConnectionTerminated;
        }
        if let Some(tls) = cause.downcast_ref::<rustls::Error>() {
            return if matches!(tls, rustls::Error::InvalidCertificate(_)) {
                Error::TlsCertificateError
            } else {
                Error::TlsProtocolError
            };
        }
        source = cause.source();
    }
    Error::InternalError(Some(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_existing_javascript_policy() {
        #[derive(serde::Deserialize)]
        struct Case {
            allow: Vec<String>,
            valid: bool,
            urls: Vec<UrlCase>,
        }
        #[derive(serde::Deserialize)]
        struct UrlCase {
            url: String,
            allowed: bool,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("../policy-cases.json")).unwrap();
        for case in cases {
            let policy = Policy::new(&case.allow);
            assert_eq!(policy.is_ok(), case.valid, "{:?}", case.allow);
            if let Ok(policy) = policy {
                for candidate in case.urls {
                    assert_eq!(
                        policy.allows(&Url::parse(&candidate.url).unwrap()),
                        candidate.allowed,
                        "{:?} {}",
                        case.allow,
                        candidate.url
                    );
                }
            }
        }
    }
    #[test]
    fn policy_denies_by_default_and_checks_host_port_and_subdomains() {
        let url = |s| Url::parse(s).unwrap();
        assert!(!Policy::new(&[]).unwrap().allows(&url("http://localhost/")));
        let p = Policy::new(&[
            "api.example.com:443".into(),
            "*.example.org".into(),
            "[::1]:8080".into(),
        ])
        .unwrap();
        for allowed in [
            "https://api.example.com/",
            "http://sub.example.org/",
            "http://[::1]:8080/",
        ] {
            assert!(p.allows(&url(allowed)));
        }
        for denied in [
            "http://api.example.com/",
            "https://otherexample.com/",
            "http://example.org/",
            "http://[::1]:8081/",
        ] {
            assert!(!p.allows(&url(denied)));
        }
        assert!(Policy::new(&["http://example.com".into(), "user@example.com".into()]).is_err());
    }
}
