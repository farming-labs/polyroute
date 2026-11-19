include!("core.rs");

include!("route.rs");

use http_body_util::BodyExt as _;
use vercel_runtime::{Request, ResponseBody};

/// Headers Vercel's bridge adds for itself. The guest never sees them.
const INTERNAL_HEADER_PREFIX: &str = "x-vercel-internal-";

impl NativeRoute {
    async fn serve_http(
        self: &Arc<Self>,
        request: Request,
    ) -> anyhow::Result<http::Response<Vec<u8>>> {
        anyhow::ensure!(
            self.authority.is_none(),
            "authority override is unsupported; Vercel supplies the request host"
        );
        let (parts, body) = request.into_parts();
        let body = body.collect().await?.to_bytes().to_vec();
        let host = parts
            .headers
            .get(http::header::HOST)
            .context("missing host header; Vercel's bridge sends one with every request")?;
        let host = host
            .to_str()
            .context("invalid host header; send an ASCII host name")?
            .parse::<http::uri::Authority>()
            .context("invalid host header; send host or host:port")?;
        let scheme = match parts
            .headers
            .get("x-forwarded-proto")
            .map(|value| value.as_bytes())
        {
            None | Some(b"https") => "https",
            Some(b"http") => "http",
            Some(_) => anyhow::bail!("invalid x-forwarded-proto header; send http or https"),
        };
        let target = parts
            .uri
            .path_and_query()
            .map_or("/", http::uri::PathAndQuery::as_str);
        let url = format!("{scheme}://{host}{target}");
        let mut headers = Vec::with_capacity(parts.headers.len() * 2);
        for (name, value) in &parts.headers {
            if name.as_str().starts_with(INTERNAL_HEADER_PREFIX) {
                continue;
            }
            headers.extend([name.to_string(), latin1_string(value.as_bytes())]);
        }
        self.handle(parts.method.to_string(), url, headers, body)
            .await
    }
}

/// The response for any request the route couldn't serve. The cause goes to
/// stderr, never into the body.
fn internal_error() -> http::Response<ResponseBody> {
    let mut response = http::Response::new(ResponseBody::from("Internal Server Error"));
    *response.status_mut() = http::StatusCode::INTERNAL_SERVER_ERROR;
    response
}

fn manifest_path() -> anyhow::Result<std::path::PathBuf> {
    let mut args = std::env::args_os().skip(1);
    let path = match args.next() {
        Some(path) => std::path::PathBuf::from(path),
        // Vercel starts the executable with no arguments, so the manifest sits
        // beside it.
        None => std::env::current_exe()?
            .parent()
            .context("the executable has no parent directory")?
            .join("manifest.json"),
    };
    anyhow::ensure!(
        args.next().is_none(),
        "unexpected arguments; pass at most the private probe manifest path"
    );
    Ok(path)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 1)]
async fn main() -> anyhow::Result<()> {
    let file = manifest_path()?;
    let bytes = std::fs::read(&file)
        .with_context(|| format!("couldn't read the manifest at {}", file.display()))?;
    let mut manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.component.is_relative() {
        let directory = file
            .parent()
            .context("the manifest has no parent directory")?;
        manifest.component = directory.join(&manifest.component);
    }
    anyhow::ensure!(
        manifest.authority.is_none(),
        "authority override is unsupported; Vercel supplies the request host"
    );
    let route = Arc::new(NativeRoute::new(manifest)?);
    let handler = route.clone();
    let result = vercel_runtime::run(vercel_runtime::service_fn(move |request: Request| {
        let route = handler.clone();
        async move {
            Ok::<_, vercel_runtime::Error>(match route.serve_http(request).await {
                Ok(response) => response.map(ResponseBody::from),
                Err(error) => {
                    eprintln!("polyroute couldn't serve the request: {error:#}");
                    internal_error()
                }
            })
        }
    }))
    .await;
    route.cancel.cancel();
    result.map_err(anyhow::Error::from_boxed)
}

#[cfg(test)]
mod vercel_tests {
    use super::*;

    #[test]
    fn internal_error_hides_the_cause() {
        let response = internal_error();
        assert_eq!(response.status(), 500);
        assert!(response.headers().is_empty());
    }
}
