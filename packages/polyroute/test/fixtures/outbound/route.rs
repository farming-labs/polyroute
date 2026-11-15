use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{Client, IntoBody, Request, Response};

#[wstd::http_server]
async fn main(_request: Request<IncomingBody>, responder: Responder) -> Finished {
    let upstream = Request::get("https://example.com")
        .body(wstd::io::empty())
        .unwrap();
    let status = match Client::new().send(upstream).await {
        Ok(response) => response.status().as_u16(),
        Err(_) => 502,
    };
    responder
        .respond(Response::new(status.to_string().into_body()))
        .await
}
