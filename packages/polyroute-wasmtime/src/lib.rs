//! Runs polyroute's `wasi:http` routes in wasmtime, called from Node through
//! Node-API. The build-time addon precompiles each route to machine code,
//! and the server maps that file into memory with [`Route`].

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use http_body::Body as _;
use http_body_util::Full;
use napi::Env;
use napi::bindgen_prelude::{Buffer, PromiseRaw};
use tokio::sync::Semaphore;

mod outbound;
mod python_http;
use napi_derive::napi;
use outbound::OutboundCallback;
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

type GuestResponse = Result<http::Response<HyperOutgoingBody>, ErrorCode>;

fn engine() -> napi::Result<&'static Engine> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            // Precompiling and loading must use the same settings, so this is
            // the only place an engine is configured.
            let mut config = Config::new();
            // CI and deployment CPUs can differ even with the same target triple.
            config
                .target(TARGET)
                .map_err(|error| format!("{error:#}"))?;
            // A process can load several copies of this addon, one per server
            // bundle. With Mach ports, each copy points the thread's exception
            // port at itself when it first runs a guest there, so a trap in a
            // copy that ran earlier reaches a handler that doesn't know its
            // code, and the process crashes with SIGILL. Signal handlers pass
            // a fault they don't own on to the one installed before them.
            config.macos_use_mach_ports(false);
            // A server reads and maps each `.cwasm` before its route's first
            // request. The address map only adds Wasm offsets to backtraces,
            // and the symbol table only serves profilers.
            config.generate_address_map(false);
            config.debug_symbols(false);
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
#[cfg(feature = "compiler")]
#[napi]
pub fn precompile(component: Buffer) -> napi::Result<Buffer> {
    let compiled = engine()?
        .precompile_component(&component)
        .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
    Ok(compiled.into())
}

#[cfg(all(test, feature = "compiler"))]
mod cpu_baseline_tests {
    use super::*;

    #[test]
    fn precompiled_code_runs_without_optional_host_cpu_features() {
        // This module exports `run() -> i32`, which returns 42.
        let wasm = [
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117,
            110, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
        ];
        let compiled = engine().unwrap().precompile_module(&wasm).unwrap();
        let mut config = Config::new();
        config.target(TARGET).unwrap();
        config.macos_use_mach_ports(false);
        config.debug_symbols(false);
        config.enable_compiler(false);
        // SAFETY: reporting every optional feature unavailable only restricts
        // execution; it never enables instructions this CPU cannot run.
        unsafe { config.detect_host_feature(|_| Some(false)) };
        let consumer = Engine::new(&config).unwrap();
        // SAFETY: these bytes were just produced by this exact Wasmtime build.
        let module = unsafe { wasmtime::Module::deserialize(&consumer, &compiled) }.unwrap();
        let mut store = Store::new(&consumer, ());
        let instance = wasmtime::Instance::new(&mut store, &module, &[]).unwrap();
        let run = instance
            .get_typed_func::<(), i32>(&mut store, "run")
            .unwrap();
        assert_eq!(run.call(&mut store, ()).unwrap(), 42);
    }

    #[test]
    fn precompiled_code_has_no_address_map_or_symbol_table() {
        // This module exports `run() -> i32`, which returns 42.
        let wasm = [
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117,
            110, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
        ];
        let compiled = engine().unwrap().precompile_module(&wasm).unwrap();
        let contains = |name: &[u8]| compiled.windows(name.len()).any(|bytes| bytes == name);
        assert!(!contains(b".wasmtime.addrmap\0"));
        // The ELF file keeps an empty symbol table; each function's symbol is
        // named like this one.
        assert!(!contains(b"wasm[0]::function[0]"));
    }
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

#[derive(Default)]
struct Hooks {
    outbound: Option<Arc<OutboundCallback>>,
}

impl WasiHttpHooks for Hooks {
    fn p2_outgoing_body_buffer_chunks(&mut self) -> usize {
        BODY_BUFFER_CHUNKS
    }

    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
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
        let callback = self.outbound.clone();
        Box::new(async move {
            let response = outbound::send(callback, request, options).await?;
            let finished: Box<dyn Future<Output = Result<(), HttpError>> + Send> =
                Box::new(async { Ok(()) });
            Ok((response, finished))
        })
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
pub struct HandleRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<String>,
    pub body: Buffer,
}

#[napi(object)]
pub struct RouteOptions {
    /// Gives every request a fresh instance instead of reusing one.
    pub per_request: bool,
    /// Replaces a reused instance after this many requests. 0 means no limit.
    pub requests_per_instance: u32,
}

/// One route's precompiled component and its independently owned instances.
#[napi]
pub struct Route {
    worker: Worker,
    idle: Arc<Mutex<Vec<Worker>>>,
    permits: Arc<Semaphore>,
}

struct Worker {
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
    /// The file must have been written by the matching build-time addon,
    /// and must not change while the process runs.
    #[napi(constructor)]
    pub fn new(path: String, options: RouteOptions) -> napi::Result<Self> {
        let engine = engine()?;
        // SAFETY: the build writes this file with the matching compiler and
        // engine configuration, and the bundle doesn't modify it while mapped.
        // wasmtime checks the version and settings recorded in the file.
        let component = unsafe { Component::deserialize_file(engine, &path) }
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        let mut linker = Linker::<Host>::new(engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
            .and_then(|()| wasmtime_wasi_http::p2::add_only_http_to_linker_sync(&mut linker))
            .and_then(|()| python_http::add_to_linker(&mut linker))
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        let pre = linker
            .instantiate_pre(&component)
            .and_then(ProxyPre::new)
            .map_err(|error| napi::Error::from_reason(format!("{error:#}")))?;
        let worker = Worker {
            engine: engine.clone(),
            pre,
            per_request: options.per_request,
            requests_per_instance: options.requests_per_instance,
            slot: None,
            stdout: Capture::default(),
            stderr: Capture::default(),
        };
        Ok(Self {
            worker,
            idle: Arc::default(),
            permits: Arc::new(Semaphore::new(32)),
        })
    }

    /// Serves a route without outbound imports on the JavaScript thread.
    #[napi]
    pub fn handle(
        &mut self,
        method: String,
        url: String,
        headers: Vec<String>,
        body: Buffer,
    ) -> HandleResult {
        self.worker
            .handle(method, url, headers, body.to_vec(), None)
    }

    /// Owns its inputs before leaving JavaScript and never uses libuv's pool.
    #[napi]
    pub fn handle_async<'env>(
        &self,
        env: &'env Env,
        request: HandleRequest,
        outbound: OutboundCallback,
    ) -> napi::Result<PromiseRaw<'env, HandleResult>> {
        let HandleRequest {
            method,
            url,
            headers,
            body,
        } = request;
        let body = body.to_vec();
        let fresh = self.worker.fresh();
        let idle = self.idle.clone();
        let permits = self.permits.clone();
        env.spawn_future(async move {
            let permit = permits
                .acquire_owned()
                .await
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            tokio::task::spawn_blocking(move || {
                let mut worker = idle.lock().unwrap().pop().unwrap_or(fresh);
                let result = worker.handle(method, url, headers, body, Some(Arc::new(outbound)));
                idle.lock().unwrap().push(worker);
                drop(permit);
                result
            })
            .await
            .map_err(|error| {
                napi::Error::from_reason(format!("native route worker failed: {error}"))
            })
        })
    }
}

impl Worker {
    fn fresh(&self) -> Self {
        Self {
            engine: self.engine.clone(),
            pre: self.pre.clone(),
            per_request: self.per_request,
            requests_per_instance: self.requests_per_instance,
            slot: None,
            stdout: Capture::default(),
            stderr: Capture::default(),
        }
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
            hooks: Hooks::default(),
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

    fn handle(
        &mut self,
        method: String,
        url: String,
        headers: Vec<String>,
        body: Vec<u8>,
        outbound: Option<Arc<OutboundCallback>>,
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

        slot.store.data_mut().hooks.outbound = outbound;
        let response: Arc<Mutex<Option<GuestResponse>>> = Arc::default();
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

        slot.store.data_mut().hooks.outbound = None;
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
    body: Vec<u8>,
) -> Result<http::Request<Full<Bytes>>, String> {
    let mut builder = http::Request::builder().method(method).uri(url);
    for [name, value] in headers.as_chunks::<2>().0 {
        builder = builder.header(name.as_str(), latin1_bytes(value));
    }
    builder
        .body(Full::new(Bytes::from(body)))
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
