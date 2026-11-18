use wstd::http::body::{BodyForthcoming, IncomingBody};
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
    let first_byte_ms =
        header("x-first-byte-timeout-ms").and_then(|value| value.parse::<u64>().ok());
    let between_bytes_ms =
        header("x-between-bytes-timeout-ms").and_then(|value| value.parse::<u64>().ok());
    let abandon = header("x-abandon");
    let method = request.method().clone();
    let body = request.body_mut().bytes().await.unwrap_or_default();

    if let Some(ms) = sleep_ms {
        wstd::task::sleep(Duration::from_millis(ms)).await;
    }

    let mut client = Client::new();
    if let Some(ms) = first_byte_ms {
        client.set_first_byte_timeout(Duration::from_millis(ms));
    }
    if let Some(ms) = between_bytes_ms {
        client.set_between_bytes_timeout(Duration::from_millis(ms));
    }
    if let Some(mode) = abandon {
        let pending = Request::builder()
            .uri(format!("{target}/abandoned"))
            .body(BodyForthcoming)
            .unwrap();
        let (body, pending) = client.start_request(pending).await.unwrap();
        Client::finish(body, None).unwrap();
        // Keep the resource alive to prove host cancellation, rather than guest cleanup.
        std::mem::forget(pending);
        let ack = Request::builder()
            .uri(format!("{target}/ack"))
            .body("".into_body())
            .unwrap();
        client.send(ack).await.unwrap();
        if mode == "trap" {
            panic!("outbound fixture trapped with a pending request");
        }
        return responder
            .respond(Response::new("finished".into_body()))
            .await;
    }

    let upstream = Request::builder()
        .method(method)
        .uri(target)
        .header("x-sent-by", "rust")
        .body(body.into_body())
        .unwrap();
    let response = match client.send(upstream).await {
        Ok(mut upstream) => {
            let status = upstream.status();
            let headers = upstream.headers().clone();
            let text = upstream.body_mut().bytes().await.unwrap_or_default();
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("x-upstream-status", status.as_u16().to_string());
            for (name, value) in &headers {
                if matches!(
                    name.as_str(),
                    "content-type"
                        | "content-encoding"
                        | "content-length"
                        | "set-cookie"
                        | "location"
                ) {
                    builder = builder.header(name, value);
                }
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
