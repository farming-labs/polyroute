use wstd::http::Request;
use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};

#[wstd::http_server]
async fn main(_request: Request<IncomingBody>, _responder: Responder) -> Finished {
    panic!("fixture route panicked on purpose");
}
