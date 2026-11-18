use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use napi::bindgen_prelude::{Buffer, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody};

use crate::{latin1_bytes, latin1_string};

#[napi(object)]
pub struct OutboundRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<String>,
    pub body: Buffer,
    // Decimal strings preserve all of WASI's u64 nanoseconds across Node-API.
    pub connect_timeout_ns: Option<String>,
    pub first_byte_timeout_ns: Option<String>,
    pub between_bytes_timeout_ns: Option<String>,
}

#[napi(object)]
pub struct OutboundResponse {
    pub status: u16,
    pub headers: Vec<String>,
    pub body: Buffer,
    pub error: Option<String>,
    pub message: Option<String>,
}

pub type OutboundCallback = ThreadsafeFunction<
    OutboundRequest,
    Promise<OutboundResponse>,
    OutboundRequest,
    napi::Status,
    false,
>;

pub async fn send(
    callback: Option<Arc<OutboundCallback>>,
    request: http::Request<WasiBody>,
    options: Option<RequestOptions>,
) -> Result<http::Response<WasiBody>, Error> {
    let callback = callback.ok_or(Error::HttpRequestDenied)?;
    let (parts, body) = request.into_parts();
    let options = options.unwrap_or_default();
    let headers = parts
        .headers
        .iter()
        .flat_map(|(name, value)| [name.to_string(), latin1_string(value.as_bytes())])
        .collect();
    let request = OutboundRequest {
        method: parts.method.to_string(),
        url: parts.uri.to_string(),
        headers,
        body: body.collect().await?.to_bytes().to_vec().into(),
        connect_timeout_ns: options
            .connect_timeout
            .map(|value| value.as_nanos().to_string()),
        first_byte_timeout_ns: options
            .first_byte_timeout
            .map(|value| value.as_nanos().to_string()),
        between_bytes_timeout_ns: options
            .between_bytes_timeout
            .map(|value| value.as_nanos().to_string()),
    };
    let promise = callback
        .call_async_catch(request)
        .await
        .map_err(bridge_error)?;
    let response = promise.await.map_err(bridge_error)?;
    if let Some(code) = response.error {
        return Err(error_code(&code, response.message));
    }
    let mut builder = http::Response::builder().status(response.status);
    if response.headers.len() % 2 != 0 {
        return Err(Error::InternalError(Some(
            "outbound headers must be name/value pairs".into(),
        )));
    }
    for pair in response.headers.chunks_exact(2) {
        builder = builder.header(pair[0].as_str(), latin1_bytes(&pair[1]));
    }
    builder
        .body(
            Full::new(Bytes::from(response.body.to_vec()))
                .map_err(Error::from)
                .boxed_unsync(),
        )
        .map_err(|error| Error::InternalError(Some(error.to_string())))
}

fn bridge_error(error: napi::Error) -> Error {
    Error::InternalError(Some(format!("outbound callback failed: {error}")))
}

fn error_code(code: &str, message: Option<String>) -> Error {
    match code {
        "DNS-error" => Error::DnsError {
            rcode: None,
            info_code: None,
        },
        "DNS-timeout" => Error::DnsTimeout,
        "destination-unavailable" => Error::DestinationUnavailable,
        "connection-refused" => Error::ConnectionRefused,
        "connection-terminated" => Error::ConnectionTerminated,
        "connection-timeout" => Error::ConnectionTimeout,
        "connection-read-timeout" => Error::ConnectionReadTimeout,
        "TLS-protocol-error" => Error::TlsProtocolError,
        "TLS-certificate-error" => Error::TlsCertificateError,
        "HTTP-response-timeout" => Error::HttpResponseTimeout,
        "HTTP-request-denied" => Error::HttpRequestDenied,
        "HTTP-request-URI-invalid" => Error::HttpRequestUriInvalid,
        "HTTP-request-method-invalid" => Error::HttpRequestMethodInvalid,
        "internal-error" => Error::InternalError(message),
        _ => Error::InternalError(Some(format!("unknown outbound error code: {code}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_policy_and_transport_failures() {
        assert!(matches!(
            error_code("HTTP-request-denied", None),
            Error::HttpRequestDenied
        ));
        assert!(matches!(
            error_code("connection-refused", None),
            Error::ConnectionRefused
        ));
        assert!(matches!(
            error_code("connection-read-timeout", None),
            Error::ConnectionReadTimeout
        ));
        assert!(matches!(error_code("DNS-timeout", None), Error::DnsTimeout));
    }

    #[test]
    fn reports_unknown_codes_instead_of_turning_them_into_success() {
        assert!(
            matches!(error_code("unexpected", None), Error::InternalError(Some(message)) if message.contains("unexpected"))
        );
    }
}
