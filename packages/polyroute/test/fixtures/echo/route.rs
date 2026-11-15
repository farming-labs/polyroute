use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{IntoBody, Request, Response, StatusCode};

#[wstd::http_server]
async fn main(mut request: Request<IncomingBody>, responder: Responder) -> Finished {
    let method = request.method().to_string();
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_default();
    let greeting = request
        .headers()
        .get("x-greeting")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none")
        .to_string();
    let body = request.body_mut().bytes().await.unwrap_or_default();
    let text = String::from_utf8_lossy(&body);

    let status = if method == "POST" {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let payload = format!("method={method}\npath={path}\ngreeting={greeting}\nbody={text}\n");
    let response = Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("x-served-by", "rust")
        .body(payload.into_body())
        .unwrap();
    responder.respond(response).await
}
