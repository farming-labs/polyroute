mod greeting;

use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{IntoBody, Request, Response};

#[wstd::http_server]
async fn main(_request: Request<IncomingBody>, responder: Responder) -> Finished {
    responder
        .respond(Response::new(greeting::message().into_body()))
        .await
}
