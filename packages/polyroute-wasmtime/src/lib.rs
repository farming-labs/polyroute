//! Runs polyroute's `wasi:http` routes in wasmtime, called from Node through
//! Node-API. A build precompiles each route to machine code with [`precompile`],
//! and the server maps that file into memory with [`Route`].

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use http_body::Body as _;
use http_body_util::Full;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::cli::{IsTerminal, StdoutStream};
use wasmtime_wasi::p2::{OutputStream, Pollable, StreamError};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p2::bindings::http::types::{ErrorCode, Scheme};
use wasmtime_wasi_http::p2::bindings::sync::{Proxy, ProxyPre};
use wasmtime_wasi_http::p2::body::HyperOutgoingBody;
use wasmtime_wasi_http::{
    Error as HttpError, RequestOptions, WasiBody, WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks,
    WasiHttpView,
};

/// The target this addon was built for. A `.cwasm` only loads on the target,
/// and with the exact wasmtime version and settings, that compiled it.
const TARGET: &str = env!("POLYROUTE_TARGET");
const WASMTIME_VERSION: &str = env!("POLYROUTE_WASMTIME_VERSION");

/// The guest writes a whole response body during one synchronous call, while
/// nothing reads it. With room for this many writes, it never waits on a
/// reader that can't run until the call returns.
const BODY_BUFFER_CHUNKS: usize = 1 << 16;

fn engine() -> napi::Result<&'static Engine> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            // Precompiling and loading must use the same settings, so this is
            // the only place an engine is configured.
            let mut config = Config::new();
            // A process can load several copies of this addon, one per server
            // bundle. With Mach ports, each copy points the thread's exception
            // port at itself when it first runs a guest there, so a trap in a
            // copy that ran earlier reaches a handler that doesn't know its
            // code, and the process crashes with SIGILL. Signal handlers pass
            // a fault they don't own on to the one installed before them.
            config.macos_use_mach_ports(false);
            Engine::new(&config).map_err(|error| format!("{error:#}"))
        })
        .as_ref()
        .map_err(|message| napi::Error::from_reason(message.clone()))
}

/// The target triple and wasmtime version a `.cwasm` from this addon needs.
#[napi(object)]
pub struct AddonInfo {
    pub target: String,
    pub wasmtime: String,
}

#[napi]
pub fn info() -> AddonInfo {
    AddonInfo {
        target: TARGET.to_string(),
        wasmtime: WASMTIME_VERSION.to_string(),
    }
}

/// Compiles a component to machine code for this addon's target.
#[napi]
pub fn precompile(component: Buffer) -> napi::Result<Buffer> {
    let compiled = engine()?
        .precompile_component(&component)
        .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
    Ok(compiled.into())
}

/// Output the guest writes to stdout or stderr, kept until the host takes it.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl IsTerminal for Capture {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for Capture {
    fn p2_stream(&self) -> Box<dyn OutputStream> {
        Box::new(self.clone())
    }

    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        Box::new(self.clone())
    }
}

#[wasmtime_wasi::async_trait]
impl Pollable for Capture {
    async fn ready(&mut self) {}
}

impl OutputStream for Capture {
    fn write(&mut self, bytes: Bytes) -> Result<(), StreamError> {
        self.0.lock().unwrap().extend_from_slice(&bytes);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), StreamError> {
        Ok(())
    }

    fn check_write(&mut self) -> Result<usize, StreamError> {
        Ok(usize::MAX)
    }
}

impl tokio::io::AsyncWrite for Capture {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct Hooks;

impl WasiHttpHooks for Hooks {
    fn p2_outgoing_body_buffer_chunks(&mut self) -> usize {
        BODY_BUFFER_CHUNKS
    }

    // The build rejects routes that import `wasi:http/outgoing-handler` for
    // this runtime, so this only answers a guest that calls it anyway.
    fn send_request(
        &mut self,
        _request: http::Request<WasiBody>,
        _options: Option<RequestOptions>,
        _fut: Box<dyn Future<Output = Result<(), HttpError>> + Send>,
    ) -> Box<
        dyn Future<
                Output = Result<
                    (
                        http::Response<WasiBody>,
                        Box<dyn Future<Output = Result<(), HttpError>> + Send>,
                    ),
                    HttpError,
                >,
            > + Send,
    > {
        Box::new(async { Err(HttpError::HttpRequestDenied) })
    }
}

struct Host {
    table: ResourceTable,
    wasi: WasiCtx,
    http: WasiHttpCtx,
    hooks: Hooks,
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for Host {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.hooks,
        }
    }
}

struct Slot {
    store: Store<Host>,
    proxy: Proxy,
    served: u32,
}

/// What one call to [`Route::handle`] produced. `outcome` is `"ok"` for a
/// response, and otherwise names the failure that `message` describes.
#[napi(object)]
pub struct HandleResult {
    pub outcome: String,
    pub status: u16,
    /// Names and values, alternating. Values are Latin-1, like `Headers`.
    pub headers: Vec<String>,
    pub body: Buffer,
    pub message: Option<String>,
    pub stdout: Buffer,
    pub stderr: Buffer,
}

#[napi(object)]
pub struct RouteOptions {
    /// Gives every request a fresh instance instead of reusing one.
    pub per_request: bool,
    /// Replaces a reused instance after this many requests. 0 means no limit.
    pub requests_per_instance: u32,
}

/// One route's precompiled component, linked once, and its reused instance.
#[napi]
pub struct Route {
    engine: Engine,
    pre: ProxyPre<Host>,
    per_request: bool,
    requests_per_instance: u32,
    slot: Option<Slot>,
    stdout: Capture,
    stderr: Capture,
}

fn latin1_bytes(value: &str) -> Vec<u8> {
    value.chars().map(|c| c as u32 as u8).collect()
}

fn latin1_string(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

#[napi]
impl Route {
    /// Maps the `.cwasm` at `path` into memory and links it.
    ///
    /// The file must have been written by [`precompile`] from this same addon,
    /// and must not change while the process runs.
    #[napi(constructor)]
    pub fn new(path: String, options: RouteOptions) -> napi::Result<Self> {
        let engine = engine()?;
        // SAFETY: the build writes this file with `precompile` from the same
        // addon, and the deployed bundle doesn't modify it while it's mapped.
        // wasmtime checks the version and settings recorded in the file.
        let component = unsafe { Component::deserialize_file(engine, &path) }
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        let mut linker = Linker::<Host>::new(engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
            .and_then(|()| wasmtime_wasi_http::p2::add_only_http_to_linker_sync(&mut linker))
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        let pre = linker
            .instantiate_pre(&component)
            .and_then(ProxyPre::new)
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        Ok(Self {
            engine: engine.clone(),
            pre,
            per_request: options.per_request,
            requests_per_instance: options.requests_per_instance,
            slot: None,
            stdout: Capture::default(),
            stderr: Capture::default(),
        })
    }

    fn instantiate(&self) -> wasmtime::Result<Slot> {
        // No preopened directories, environment, or arguments, and no
        // sockets or name lookups, like polyroute's own WASI host.
        let wasi = WasiCtxBuilder::new()
            .stdout(self.stdout.clone())
            .stderr(self.stderr.clone())
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false)
            .build();
        let host = Host {
            table: ResourceTable::new(),
            wasi,
            http: WasiHttpCtx::new(),
            hooks: Hooks,
        };
        let mut store = Store::new(&self.engine, host);
        let proxy = self.pre.instantiate(&mut store)?;
        Ok(Slot {
            store,
            proxy,
            served: 0,
        })
    }

    fn result(&self, outcome: &str, message: Option<String>) -> HandleResult {
        HandleResult {
            outcome: outcome.to_string(),
            status: 0,
            headers: Vec::new(),
            body: Vec::new().into(),
            message,
            stdout: self.stdout.take().into(),
            stderr: self.stderr.take().into(),
        }
    }

    /// Serves one request. Runs synchronously on the calling thread.
    #[napi]
    pub fn handle(
        &mut self,
        method: String,
        url: String,
        headers: Vec<String>,
        body: Buffer,
    ) -> HandleResult {
        let mut slot = match self.slot.take() {
            Some(slot) => slot,
            None => match self.instantiate() {
                Ok(slot) => slot,
                Err(error) => {
                    return self.result("instantiation-failed", Some(format!("{error:#}")));
                }
            },
        };

        let request = match build_request(&method, &url, &headers, body) {
            Ok(request) => request,
            Err(message) => {
                self.slot = Some(slot);
                return self.result("invalid-request", Some(message));
            }
        };

        let response: Arc<Mutex<Option<Result<http::Response<HyperOutgoingBody>, ErrorCode>>>> =
            Arc::default();
        let call = (|| -> wasmtime::Result<()> {
            let mut http = slot.store.data_mut().http();
            let scheme = if url.starts_with("https:") {
                Scheme::Https
            } else {
                Scheme::Http
            };
            let incoming = http.new_incoming_request(scheme, request)?;
            let sink = response.clone();
            let outparam = http.new_response_outparam_from_callback(move |value| {
                *sink.lock().unwrap() = Some(value);
            })?;
            slot.proxy
                .wasi_http_incoming_handler()
                .call_handle(&mut slot.store, incoming, outparam)
        })();

        if let Err(error) = call {
            // A trapped instance can't be trusted or called again, so it's
            // dropped here and the next request gets a new one.
            return self.result("trap", Some(format!("{error:?}")));
        }

        slot.served += 1;
        let keep = !self.per_request
            && (self.requests_per_instance == 0 || slot.served < self.requests_per_instance);
        let taken = response.lock().unwrap().take();
        let collected = match taken {
            None => Err(("no-response", None)),
            Some(Err(code)) => Err(("error-code", Some(format!("{code:?}")))),
            Some(Ok(response)) => {
                collect(response).map_err(|message| ("unfinished-body", Some(message)))
            }
        };
        // The response is read before a retired instance's store is dropped,
        // so its body can't be cut short by the drop.
        if keep {
            self.slot = Some(slot);
        } else {
            drop(slot);
        }

        match collected {
            Ok((status, headers, body)) => HandleResult {
                outcome: "ok".to_string(),
                status,
                headers,
                body: body.into(),
                message: None,
                stdout: self.stdout.take().into(),
                stderr: self.stderr.take().into(),
            },
            Err((outcome, message)) => self.result(outcome, message),
        }
    }
}

fn build_request(
    method: &str,
    url: &str,
    headers: &[String],
    body: Buffer,
) -> Result<http::Request<Full<Bytes>>, String> {
    let mut builder = http::Request::builder().method(method).uri(url);
    for pair in headers.chunks_exact(2) {
        builder = builder.header(pair[0].as_str(), latin1_bytes(&pair[1]));
    }
    builder
        .body(Full::new(Bytes::from(Vec::from(body))))
        .map_err(|error| error.to_string())
}

type Collected = (u16, Vec<String>, Vec<u8>);

/// Reads a response the guest has already finished writing. Its body was fully
/// buffered during the call, so every poll is ready unless the guest left the
/// body unfinished.
fn collect(response: http::Response<HyperOutgoingBody>) -> Result<Collected, String> {
    let (parts, mut body) = response.into_parts();
    let mut context = Context::from_waker(Waker::noop());
    let mut bytes = Vec::new();
    loop {
        match Pin::new(&mut body).poll_frame(&mut context) {
            Poll::Ready(None) => break,
            Poll::Ready(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    bytes.extend_from_slice(&data);
                }
            }
            Poll::Ready(Some(Err(error))) => return Err(error.to_string()),
            Poll::Pending => {
                return Err("the route started a response body but never finished it".to_string());
            }
        }
    }
    let mut headers = Vec::with_capacity(parts.headers.len() * 2);
    for (name, value) in &parts.headers {
        headers.push(name.as_str().to_string());
        headers.push(latin1_string(value.as_bytes()));
    }
    Ok((parts.status.as_u16(), headers, bytes))
}
