include!("core.rs");

include!("route.rs");

impl NativeRoute {
    async fn serve_inner(
        self: &Arc<Self>,
        request: lambda_http::Request,
    ) -> anyhow::Result<http::Response<lambda_http::Body>> {
        let (parts, body) = request.into_parts();
        let body = body.as_ref().to_vec();
        anyhow::ensure!(
            self.authority.is_none(),
            "authority override is unsupported; use the Lambda event URI"
        );
        anyhow::ensure!(
            matches!(parts.uri.scheme_str(), Some("http" | "https"))
                && parts.uri.authority().is_some(),
            "incomplete request URI; supply a valid HTTP API v2 event"
        );
        let url = parts.uri.to_string();
        let method = parts.method.to_string();
        let mut headers = Vec::with_capacity(parts.headers.len() * 2);
        for (name, value) in &parts.headers {
            let value = std::str::from_utf8(value.as_bytes())
                .context("invalid Lambda header encoding; provide JSON string header values")?;
            anyhow::ensure!(
                value.chars().all(|character| u32::from(character) <= 255),
                "invalid `{name}` header value; use only Latin-1 characters"
            );
            headers.extend([name.to_string(), value.to_string()]);
        }
        let response = self.handle(method, url, headers, body).await?;
        Ok(response.map(lambda_http::Body::Binary))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LambdaResponse {
    status_code: u16,
    headers: std::collections::BTreeMap<String, String>,
    cookies: Vec<String>,
    body: String,
    is_base64_encoded: bool,
}

fn encode_response(response: http::Response<lambda_http::Body>) -> LambdaResponse {
    use base64::Engine as _;
    let (parts, body) = response.into_parts();
    let mut headers = std::collections::BTreeMap::new();
    let mut cookies = Vec::new();
    for name in parts.headers.keys() {
        let values = parts
            .headers
            .get_all(name)
            .iter()
            .map(|value| latin1_string(value.as_bytes()));
        if name == http::header::SET_COOKIE {
            cookies.extend(values);
        } else {
            headers.insert(name.to_string(), values.collect::<Vec<_>>().join(","));
        }
    }
    LambdaResponse {
        status_code: parts.status.as_u16(),
        headers,
        cookies,
        body: base64::engine::general_purpose::STANDARD.encode(body.as_ref()),
        is_base64_encoded: true,
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 1)]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let file = args
        .next()
        .context("missing manifest; pass the private probe manifest path")?;
    anyhow::ensure!(
        args.next().is_none(),
        "unexpected arguments; pass only the private probe manifest path"
    );
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(file)?)?;
    anyhow::ensure!(
        manifest.authority.is_none(),
        "authority override is unsupported; use the Lambda event URI"
    );
    for key in [
        "AWS_LAMBDA_RUNTIME_API",
        "AWS_LAMBDA_FUNCTION_NAME",
        "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
        "AWS_LAMBDA_FUNCTION_VERSION",
    ] {
        anyhow::ensure!(
            !std::env::var(key).unwrap_or_default().is_empty(),
            "missing {key}; launch through a configured Lambda runtime"
        );
    }
    let route = Arc::new(NativeRoute::new(manifest)?);
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let handler = route.clone();
    let runtime = lambda_http::lambda_runtime::run(lambda_http::service_fn(
        move |event: lambda_http::LambdaEvent<Box<serde_json::value::RawValue>>| {
            let route = handler.clone();
            async move {
                use lambda_http::RequestExt as _;
                let request = lambda_http::request::from_str(event.payload.get())?
                    .with_lambda_context(event.context);
                let response = route.serve_inner(request).await?;
                Ok::<_, lambda_http::Error>(encode_response(response))
            }
        },
    ));
    let result = tokio::select! {
        result = runtime => result,
        _ = interrupt.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
    };
    route.cancel.cancel();
    result.map_err(anyhow::Error::from_boxed)
}

#[cfg(test)]
mod adapter_tests {
    use super::*;

    #[test]
    fn response_json_preserves_binary_and_all_header_values() {
        let response = http::Response::builder()
            .status(201)
            .header("x-probe", b"caf\xe9".as_slice())
            .header("x-repeated", "one")
            .header("x-repeated", "two")
            .header("set-cookie", "a=1")
            .header("set-cookie", b"b=caf\xe9".as_slice())
            .body(lambda_http::Body::Binary(vec![0, 255, 128, 1]))
            .unwrap();
        let encoded = encode_response(response);
        let json = serde_json::to_value(encoded).unwrap();
        assert_eq!(json["statusCode"], 201);
        assert_eq!(json["headers"]["x-probe"], "café");
        assert_eq!(json["headers"]["x-repeated"], "one,two");
        assert_eq!(json["cookies"], serde_json::json!(["a=1", "b=café"]));
        assert_eq!(json["body"], "AP+AAQ==");
        assert_eq!(json["isBase64Encoded"], true);
        assert!(json["headers"].get("set-cookie").is_none());
    }

    #[test]
    fn empty_response_encodes_without_fabricated_headers() {
        let response = http::Response::builder()
            .status(204)
            .body(lambda_http::Body::Empty)
            .unwrap();
        let encoded = encode_response(response);
        assert_eq!(encoded.status_code, 204);
        assert!(encoded.headers.is_empty());
        assert!(encoded.cookies.is_empty());
        assert!(encoded.body.is_empty());
    }
}
