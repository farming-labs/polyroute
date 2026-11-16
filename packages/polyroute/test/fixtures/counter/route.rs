use std::sync::atomic::{AtomicU32, Ordering};

use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{IntoBody, Request, Response};

static REQUESTS: AtomicU32 = AtomicU32::new(0);

#[wstd::http_server]
async fn main(request: Request<IncomingBody>, responder: Responder) -> Finished {
    let count = REQUESTS.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("counter served request {count}");
    if request.uri().path() == "/panic" {
        panic!("counter panicked on request {count}");
    }
    let response = Response::builder()
        .header("content-type", "text/plain")
        .body(count.to_string().into_body())
        .unwrap();
    responder.respond(response).await
}
