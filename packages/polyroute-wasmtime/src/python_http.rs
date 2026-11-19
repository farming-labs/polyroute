//! Buffered transfers for the native Python adapter, using the WASI resources
//! and validation shared with the portable adapter.

use wasmtime::component::{ComponentType, Lift, Linker, Lower, Resource};
use wasmtime::{StoreContextMut, format_err};
use wasmtime_wasi::p2::StreamError;
use wasmtime_wasi::p2::bindings::sync::io::streams::{HostInputStream, HostOutputStream};
use wasmtime_wasi_http::WasiHttpView;
use wasmtime_wasi_http::p2::bindings::http::types::{self, Method, Scheme};
use wasmtime_wasi_http::p2::types::{HostIncomingRequest, HostResponseOutparam};

use crate::Host;

#[derive(ComponentType, Lift, Lower)]
#[component(record)]
struct RequestData {
    method: String,
    url: String,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}

#[derive(ComponentType, Lift, Lower)]
#[component(record)]
struct ResponseData {
    status: u16,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}

pub fn add_to_linker(linker: &mut Linker<Host>) -> wasmtime::Result<()> {
    let mut interface = linker.instance("polyroute:route/native-http")?;
    interface.func_wrap(
        "read-request",
        |mut store: StoreContextMut<'_, Host>, (request,): (Resource<HostIncomingRequest>,)| {
            Ok((read_request(store.data_mut(), request)?,))
        },
    )?;
    interface.func_wrap(
        "send-response",
        |mut store: StoreContextMut<'_, Host>,
         (outparam, response): (Resource<HostResponseOutparam>, ResponseData)| {
            send_response(store.data_mut(), outparam, response)
        },
    )?;
    Ok(())
}

fn read_request(
    host: &mut Host,
    request: Resource<HostIncomingRequest>,
) -> wasmtime::Result<RequestData> {
    let borrow = || Resource::new_borrow(request.rep());
    let mut http = host.http();
    let method = match types::HostIncomingRequest::method(&mut http, borrow())? {
        Method::Get => "GET".to_string(),
        Method::Head => "HEAD".to_string(),
        Method::Post => "POST".to_string(),
        Method::Put => "PUT".to_string(),
        Method::Delete => "DELETE".to_string(),
        Method::Connect => "CONNECT".to_string(),
        Method::Options => "OPTIONS".to_string(),
        Method::Trace => "TRACE".to_string(),
        Method::Patch => "PATCH".to_string(),
        Method::Other(method) => method,
    };
    let scheme = match types::HostIncomingRequest::scheme(&mut http, borrow())? {
        Some(Scheme::Https) => "https".to_string(),
        Some(Scheme::Other(scheme)) => scheme,
        _ => "http".to_string(),
    };
    let authority = types::HostIncomingRequest::authority(&mut http, borrow())?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_string());
    let path = types::HostIncomingRequest::path_with_query(&mut http, borrow())?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/".to_string());
    let fields = types::HostIncomingRequest::headers(&mut http, borrow())?;
    let headers = types::HostFields::entries(&mut http, Resource::new_borrow(fields.rep()))?;
    types::HostFields::drop(&mut http, fields)?;
    let incoming = types::HostIncomingRequest::consume(&mut http, borrow())?
        .map_err(|()| format_err!("incoming request body was already consumed"))?;
    let stream = types::HostIncomingBody::stream(&mut http, Resource::new_borrow(incoming.rep()))?
        .map_err(|()| format_err!("incoming request stream was already consumed"))?;
    let mut body = Vec::new();
    loop {
        match HostInputStream::blocking_read(http.table, Resource::new_borrow(stream.rep()), 65536)
        {
            Ok(chunk) => body.extend_from_slice(&chunk),
            Err(StreamError::Closed) => break,
            Err(error) => return Err(format_err!("reading the incoming request failed: {error}")),
        }
    }
    HostInputStream::drop(http.table, stream)?;
    let trailers = types::HostIncomingBody::finish(&mut http, incoming)?;
    types::HostFutureTrailers::drop(&mut http, trailers)?;
    Ok(RequestData {
        method,
        url: format!("{scheme}://{authority}{path}"),
        headers,
        body,
    })
}

fn send_response(
    host: &mut Host,
    outparam: Resource<HostResponseOutparam>,
    response: ResponseData,
) -> wasmtime::Result<()> {
    let mut http = host.http();
    let fields = types::HostFields::from_list(&mut http, response.headers)
        .map_err(|error| format_err!("invalid response headers: {error}"))?;
    let outgoing = types::HostOutgoingResponse::new(&mut http, fields)?;
    types::HostOutgoingResponse::set_status_code(
        &mut http,
        Resource::new_borrow(outgoing.rep()),
        response.status,
    )?
    .map_err(|()| format_err!("invalid response status"))?;
    let body = types::HostOutgoingResponse::body(&mut http, Resource::new_borrow(outgoing.rep()))?
        .map_err(|()| format_err!("invalid response body or content-length"))?;
    types::HostResponseOutparam::set(&mut http, outparam, Ok(outgoing))?;
    let stream = types::HostOutgoingBody::write(&mut http, Resource::new_borrow(body.rep()))?
        .map_err(|()| format_err!("outgoing response stream was already consumed"))?;
    for chunk in response.body.chunks(4096) {
        HostOutputStream::blocking_write_and_flush(
            http.table,
            Resource::new_borrow(stream.rep()),
            chunk.to_vec(),
        )
        .map_err(|error| format_err!("writing the outgoing response failed: {error}"))?;
    }
    HostOutputStream::drop(http.table, stream)?;
    types::HostOutgoingBody::finish(&mut http, body, None)
        .map_err(|error| format_err!("finishing the outgoing response failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use wasmtime::component::ResourceTable;
    use wasmtime_wasi::WasiCtxBuilder;
    use wasmtime_wasi_http::WasiHttpCtx;

    fn host() -> Host {
        Host {
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
            http: WasiHttpCtx::new(),
            hooks: crate::Hooks::default(),
        }
    }

    #[test]
    fn requests_consume_once_and_release_temporary_resources() -> wasmtime::Result<()> {
        let mut host = host();
        let payload: Vec<u8> = (0..131073).map(|value| value as u8).collect();
        for _ in 0..128 {
            let request = crate::build_request(
                "CUSTOM",
                "https://example.test/path?q=a%20b",
                &[
                    "x-probe".into(),
                    "one".into(),
                    "x-probe".into(),
                    "two".into(),
                ],
                payload.clone(),
            )
            .unwrap();
            let incoming = host.http().new_incoming_request(Scheme::Https, request)?;
            let data = read_request(&mut host, Resource::new_borrow(incoming.rep()))?;
            assert_eq!(data.method, "CUSTOM");
            assert_eq!(data.url, "https://example.test/path?q=a%20b");
            assert_eq!(
                data.headers,
                vec![
                    ("x-probe".into(), b"one".to_vec()),
                    ("x-probe".into(), b"two".to_vec())
                ]
            );
            assert_eq!(data.body, payload);
            assert!(read_request(&mut host, Resource::new_borrow(incoming.rep())).is_err());
            assert_eq!(host.table.iter_mut().count(), 1);
            types::HostIncomingRequest::drop(&mut host.http(), incoming)?;
            assert!(host.table.is_empty());
        }
        Ok(())
    }

    #[test]
    fn responses_finish_and_release_every_resource() -> wasmtime::Result<()> {
        let mut host = host();
        let payload: Vec<u8> = (0..131073).map(|value| value as u8).collect();
        for _ in 0..128 {
            let response = Arc::new(Mutex::new(None));
            let sink = response.clone();
            let outparam = host
                .http()
                .new_response_outparam_from_callback(move |value| {
                    *sink.lock().unwrap() = Some(value);
                })?;
            send_response(
                &mut host,
                outparam,
                ResponseData {
                    status: 201,
                    headers: vec![
                        (
                            "content-length".into(),
                            payload.len().to_string().into_bytes(),
                        ),
                        ("set-cookie".into(), b"a=1".to_vec()),
                        ("set-cookie".into(), b"b=2".to_vec()),
                    ],
                    body: payload.clone(),
                },
            )?;
            assert!(host.table.is_empty());
            let response = response.lock().unwrap().take().unwrap().unwrap();
            let (status, headers, body) = crate::collect(response).unwrap();
            assert_eq!(status, 201);
            assert_eq!(
                headers
                    .iter()
                    .filter(|value| value.as_str() == "set-cookie")
                    .count(),
                2
            );
            assert_eq!(body, payload);
        }
        Ok(())
    }

    #[test]
    fn stale_or_wrong_resource_types_fail() -> wasmtime::Result<()> {
        let mut host = host();
        let outparam = host.http().new_response_outparam_from_callback(|_| {})?;
        let rep = outparam.rep();
        assert!(read_request(&mut host, Resource::new_borrow(rep)).is_err());
        types::HostResponseOutparam::drop(&mut host.http(), outparam)?;
        assert!(read_request(&mut host, Resource::new_borrow(rep)).is_err());
        assert!(
            send_response(
                &mut host,
                Resource::new_own(rep),
                ResponseData {
                    status: 200,
                    headers: vec![],
                    body: vec![],
                }
            )
            .is_err()
        );
        Ok(())
    }
}
