use anyhow::Context as _;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    component: std::path::PathBuf,
    #[serde(default)]
    per_request: bool,
    #[serde(default)]
    requests_per_instance: u32,
    outbound_allow: Option<Vec<String>>,
    authority: Option<String>,
    /// Adds a `Server-Timing` header with each phase's duration. For provider
    /// measurements; off by default.
    #[serde(default)]
    server_timing: bool,
}

/// Startup phases an adapter measured before readiness, in order. The first
/// response reports them, followed by `wait`: from readiness until that request
/// arrived.
struct Startup {
    phases: Vec<(&'static str, Duration)>,
    ready_at: Instant,
}

/// One long-lived thread for synchronous guest calls. They arrive one at a
/// time, reuse the thread's Wasmtime state and stack, and run outside the Tokio
/// runtime, where Wasmtime's synchronous imports use wasmtime-wasi's runtime.
/// The thread exits when its route is dropped.
struct GuestThread {
    jobs: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

impl GuestThread {
    fn new() -> std::io::Result<Self> {
        let (jobs, receiver) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name("polyroute-guest".into())
            .spawn(move || {
                for job in receiver {
                    job();
                }
            })?;
        Ok(Self { jobs })
    }

    /// Runs `job` on the guest thread and blocks the calling thread until it
    /// returns. A panic in `job` resumes on the calling thread.
    fn run<R: Send + 'static>(&self, job: impl FnOnce() -> R + Send + 'static) -> R {
        let (done, result) = std::sync::mpsc::sync_channel(1);
        self.jobs
            .send(Box::new(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                let _ = done.send(outcome);
            }))
            .expect("the guest thread runs as long as its route");
        match result.recv().expect("the guest thread returns every job") {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}

struct NativeRoute {
    synchronous: Mutex<Worker>,
    guest: GuestThread,
    template: Mutex<Worker>,
    idle: Mutex<Vec<Worker>>,
    permits: Arc<Semaphore>,
    outbound: Option<Arc<outbound::ClientState>>,
    authority: Option<String>,
    cancel: CancellationToken,
    server_timing: bool,
    startup: Mutex<Option<Startup>>,
}

/// Loads a precompiled component. A `.zst` file is decompressed into memory
/// first. Vercel's function file system stores files compressed and measured
/// about 115 MB/s reading a raw component, against about 270 MB/s for the same
/// component already compressed with zstd.
fn load_component(engine: &Engine, path: &std::path::Path) -> wasmtime::Result<Component> {
    if path.extension().is_some_and(|extension| extension == "zst") {
        let compressed = std::fs::read(path)
            .map_err(|error| wasmtime::format_err!("couldn't read {}: {error}", path.display()))?;
        let size = match zstd::zstd_safe::get_frame_content_size(&compressed) {
            Ok(Some(size)) => size,
            Ok(None) => wasmtime::bail!(
                "{} doesn't record its decompressed size; compress it with the size included, as the `zstd` command does",
                path.display()
            ),
            Err(_) => wasmtime::bail!(
                "{} isn't a zstd file; compress the component with `zstd` or remove the .zst extension",
                path.display()
            ),
        };
        let bytes =
            zstd::bulk::decompress(&compressed, usize::try_from(size)?).map_err(|error| {
                wasmtime::format_err!("couldn't decompress {}: {error}", path.display())
            })?;
        // SAFETY: this private probe loads only the recorded trusted build artifacts.
        unsafe { Component::deserialize(engine, &bytes) }
    } else {
        // SAFETY: this private probe loads only the recorded trusted build artifacts.
        unsafe { Component::deserialize_file(engine, path) }
    }
}

impl NativeRoute {
    fn new(manifest: Manifest) -> anyhow::Result<Self> {
        let worker = (|| -> wasmtime::Result<Worker> {
            let engine = engine()?;
            let component = load_component(engine, &manifest.component)?;
            let mut linker = Linker::<Host>::new(engine);
            wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
            wasmtime_wasi_http::p2::add_only_http_to_linker_sync(&mut linker)?;
            python_http::add_to_linker(&mut linker)?;
            let pre = ProxyPre::new(linker.instantiate_pre(&component)?)?;
            Ok(Worker {
                engine: engine.clone(),
                pre,
                per_request: manifest.per_request,
                requests_per_instance: manifest.requests_per_instance,
                slot: None,
                stdout: Capture::default(),
                stderr: Capture::default(),
            })
        })()
        .map_err(|error| anyhow::Error::from_boxed(error.into_boxed_dyn_error()))?;
        let outbound = manifest
            .outbound_allow
            .as_ref()
            .map(|allow| outbound::ClientState::new(allow))
            .transpose()?;
        if let Some(authority) = &manifest.authority {
            authority
                .parse::<http::uri::Authority>()
                .context("invalid authority override; supply host:port")?;
        }
        Ok(Self {
            synchronous: Mutex::new(worker.fresh()),
            guest: GuestThread::new().context("couldn't start the guest thread")?,
            template: Mutex::new(worker),
            idle: Mutex::new(Vec::new()),
            permits: Arc::new(Semaphore::new(32)),
            outbound,
            authority: manifest.authority,
            cancel: CancellationToken::new(),
            server_timing: manifest.server_timing,
            startup: Mutex::new(None),
        })
    }

    /// The `Server-Timing` value for one response, in milliseconds: the time
    /// to create an instance if this request needed one, and the guest call.
    /// The first response also reports the adapter's startup phases.
    fn timing(&self, arrived: Instant, result: &HandleResult) -> String {
        let ms = |duration: Duration| duration.as_secs_f64() * 1000.0;
        let mut metrics = Vec::new();
        if let Some(startup) = self.startup.lock().unwrap().take() {
            for (name, duration) in startup.phases {
                metrics.push(format!("{name};dur={:.2}", ms(duration)));
            }
            let wait = arrived.saturating_duration_since(startup.ready_at);
            metrics.push(format!("wait;dur={:.2}", ms(wait)));
        }
        if let Some(instantiate) = result.instantiate {
            metrics.push(format!("instantiate;dur={:.2}", ms(instantiate)));
        }
        metrics.push(format!("call;dur={:.2}", ms(result.call)));
        metrics.join(", ")
    }

    /// Runs one request through a guest. `headers` alternates names and
    /// Latin-1 values, as the Node addon receives them.
    async fn handle(
        self: &Arc<Self>,
        method: String,
        url: String,
        headers: Vec<String>,
        body: Vec<u8>,
    ) -> anyhow::Result<http::Response<Vec<u8>>> {
        let arrived = Instant::now();
        let result = if let Some(state) = &self.outbound {
            let permit = self.permits.clone().acquire_owned().await?;
            let route = self.clone();
            let method = method.clone();
            let outbound = OutboundContext {
                state: state.clone(),
                cancel: self.cancel.child_token(),
            };
            tokio::task::spawn_blocking(move || {
                let mut worker = route
                    .idle
                    .lock()
                    .unwrap()
                    .pop()
                    .unwrap_or_else(|| route.template.lock().unwrap().fresh());
                let result = worker.handle(method, url, headers, body, Some(outbound));
                route.idle.lock().unwrap().push(worker);
                drop(permit);
                result
            })
            .await?
        } else {
            // Synchronous guest calls run one at a time on the guest thread,
            // and this one holds the runtime's only worker until it returns.
            // Vercel sends concurrent requests to an instance until it stops
            // answering `/_vercel/ping` promptly, as a Node instance does while
            // it runs a request. `block_in_place` handed the runtime to another
            // thread that kept answering, so Vercel queued requests behind the
            // guest instead of starting another instance.
            let route = self.clone();
            let guest_method = method.clone();
            self.guest.run(move || {
                route
                    .synchronous
                    .lock()
                    .unwrap()
                    .handle(guest_method, url, headers, body, None)
            })
        };
        use std::io::Write as _;
        std::io::stdout().write_all(&result.stdout)?;
        std::io::stderr().write_all(&result.stderr)?;
        anyhow::ensure!(
            result.outcome == "ok",
            "{}: {}",
            result.outcome,
            result.message.unwrap_or_default()
        );
        anyhow::ensure!(
            result.status >= 200,
            "invalid final status {}; return a final HTTP status",
            result.status
        );
        let mut response = http::Response::builder().status(result.status);
        if self.server_timing {
            response = response.header("server-timing", self.timing(arrived, &result));
        }
        for [name, value] in result.headers.as_chunks::<2>().0 {
            if name == "content-length" {
                let length: usize = value
                    .parse()
                    .context("invalid content-length; send a decimal byte count")?;
                anyhow::ensure!(
                    length == result.body.len(),
                    "content-length mismatch; declare the actual body size"
                );
            }
            response = response.header(name, latin1_bytes(value));
        }
        let body = if method == "HEAD" || matches!(result.status, 204 | 205 | 304) {
            Vec::new()
        } else {
            result.body
        };
        Ok(response.body(body)?)
    }
}
