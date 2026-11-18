use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{Client, IntoBody, Request, Response, StatusCode};

// Calls this server's own TypeScript route with wstd's HTTP client, the way a
// route calls any API. `outbound.allow` in vite.config.ts lets it reach this host.
#[wstd::http_server]
async fn main(request: Request<IncomingBody>, responder: Responder) -> Finished {
    let authority = request
        .uri()
        .authority()
        .map(|authority| authority.to_string())
        .unwrap_or_default();
    let hello = Request::get(format!("http://{authority}/api/hello"))
        .body(wstd::io::empty())
        .unwrap();
    let response = match Client::new().send(hello).await {
        Ok(mut hello) => {
            let body = hello.body_mut().bytes().await.unwrap_or_default();
            let relayed = format!("{{\"relayed\":{}}}", String::from_utf8_lossy(&body));
            Response::builder()
                .header("content-type", "application/json")
                .body(relayed.into_body())
                .unwrap()
        }
        Err(error) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(format!("{error:?}").into_body())
            .unwrap(),
    };
    responder.respond(response).await
}
