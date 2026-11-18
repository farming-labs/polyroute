use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{Client, IntoBody, Request, Response, StatusCode};
use wstd::time::Duration;

// Sends the request it receives to the URL in its `x-upstream` header, so tests
// can point it at a local server, and answers with what came back.
#[wstd::http_server]
async fn main(mut request: Request<IncomingBody>, responder: Responder) -> Finished {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let target = header("x-upstream").unwrap_or_default();
    let sleep_ms = header("x-sleep-ms").and_then(|value| value.parse::<u64>().ok());
    let method = request.method().clone();
    let body = request.body_mut().bytes().await.unwrap_or_default();

    if let Some(ms) = sleep_ms {
        wstd::task::sleep(Duration::from_millis(ms)).await;
    }

    let upstream = Request::builder()
        .method(method)
        .uri(target)
        .header("x-sent-by", "rust")
        .body(body.into_body())
        .unwrap();
    let response = match Client::new().send(upstream).await {
        Ok(mut upstream) => {
            let status = upstream.status();
            let content_type = upstream.headers().get("content-type").cloned();
            let text = upstream.body_mut().bytes().await.unwrap_or_default();
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("x-upstream-status", status.as_u16().to_string());
            if let Some(value) = content_type {
                builder = builder.header("content-type", value);
            }
            builder.body(text.into_body()).unwrap()
        }
        Err(error) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(format!("{error:?}").into_body())
            .unwrap(),
    };
    responder.respond(response).await
}
