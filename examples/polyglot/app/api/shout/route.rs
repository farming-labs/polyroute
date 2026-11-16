use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{IntoBody, Method, Request, Response, StatusCode};

#[wstd::http_server]
async fn main(mut request: Request<IncomingBody>, responder: Responder) -> Finished {
    if request.method() != Method::POST {
        let response = Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", "POST")
            .body("".into_body())
            .unwrap();
        return responder.respond(response).await;
    }

    let body = request.body_mut().bytes().await.unwrap_or_default();
    let shouted = String::from_utf8_lossy(&body).to_uppercase();
    let response = Response::builder()
        .header("content-type", "text/plain; charset=utf-8")
        .body(shouted.into_body())
        .unwrap();
    responder.respond(response).await
}
