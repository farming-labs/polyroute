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
/// time, reuse the thread's Wasmtime state and stack, and run outside the
/// runtime that serves requests. The thread exits when its route is dropped.
struct GuestThread {
    jobs: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

impl GuestThread {
    fn new() -> std::io::Result<Self> {
        // Wasmtime's synchronous imports drive their futures on the current
        // Tokio handle, as they did inside `block_in_place`. This runtime's
        // worker drives their timers and I/O while the serving runtime waits.
        // Without a handle, wasmtime-wasi falls back to a global runtime with
        // a worker per CPU and yields before every call.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("polyroute-guest-io")
            .enable_all()
            .build()?;
        let (jobs, receiver) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name("polyroute-guest".into())
            .spawn(move || {
                let _context = runtime.enter();
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
        let frames = zstd_frames(path, &compressed)?;
        let size = frames.iter().map(|frame| frame.size).sum();
        #[cfg(target_os = "linux")]
        return load_from_memory_file(engine, path, &compressed, &frames, size);
        #[cfg(not(target_os = "linux"))]
        {
            let mut bytes = vec![0; size];
            decompress_frames(path, &compressed, &frames, &mut bytes)?;
            // SAFETY: this private probe loads only the recorded trusted build artifacts.
            unsafe { Component::deserialize(engine, &bytes) }
        }
    } else {
        // SAFETY: this private probe loads only the recorded trusted build artifacts.
        unsafe { Component::deserialize_file(engine, path) }
    }
}

/// One zstd frame of a compressed component.
struct Frame {
    compressed: std::ops::Range<usize>,
    size: usize,
}

/// Finds the zstd frames a compressed component is made of. Each frame must
/// record its decompressed size.
fn zstd_frames(path: &std::path::Path, compressed: &[u8]) -> wasmtime::Result<Vec<Frame>> {
    let not_zstd = || {
        wasmtime::format_err!(
            "{} isn't a zstd file; compress the component with `zstd` or remove the .zst extension",
            path.display()
        )
    };
    if compressed.is_empty() {
        return Err(not_zstd());
    }
    let mut frames = Vec::new();
    let mut start = 0;
    while start < compressed.len() {
        let rest = &compressed[start..];
        let size = match zstd::zstd_safe::get_frame_content_size(rest) {
            Ok(Some(size)) => usize::try_from(size)?,
            Ok(None) => wasmtime::bail!(
                "{} doesn't record its decompressed size; compress it with the size included, as the `zstd` command does",
                path.display()
            ),
            Err(_) => return Err(not_zstd()),
        };
        let length = zstd::zstd_safe::find_frame_compressed_size(rest).map_err(|_| {
            wasmtime::format_err!(
                "{} ends partway through a zstd frame; compress the component again",
                path.display()
            )
        })?;
        frames.push(Frame {
            compressed: start..start + length,
            size,
        });
        start += length;
    }
    Ok(frames)
}

/// Decompresses each frame into its own part of `output`, which holds exactly
/// the frames' decompressed sizes. Frames run on as many threads as the
/// instance has CPUs; Vercel's instances report two, and decompressing took
/// most of a large component's load time on one.
fn decompress_frames(
    path: &std::path::Path,
    compressed: &[u8],
    frames: &[Frame],
    output: &mut [u8],
) -> wasmtime::Result<()> {
    let mut parts = Vec::with_capacity(frames.len());
    let mut rest = output;
    for frame in frames {
        let (part, after) = rest.split_at_mut(frame.size);
        parts.push((frame, part));
        rest = after;
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, std::num::NonZero::get)
        .min(frames.len());
    let parts = Mutex::new(parts.into_iter());
    let decompress = || -> wasmtime::Result<()> {
        let mut decompressor = zstd::bulk::Decompressor::new()?;
        loop {
            let Some((frame, part)) = parts.lock().unwrap().next() else {
                return Ok(());
            };
            let written = decompressor
                .decompress_to_buffer(&compressed[frame.compressed.clone()], part)
                .map_err(|error| {
                    wasmtime::format_err!("couldn't decompress {}: {error}", path.display())
                })?;
            wasmtime::ensure!(
                written == frame.size,
                "{} decompressed to fewer bytes than it records; compress the component again",
                path.display()
            );
        }
    };
    std::thread::scope(|scope| {
        let helpers: Vec<_> = (1..threads).map(|_| scope.spawn(decompress)).collect();
        let mine = decompress();
        helpers
            .into_iter()
            .map(|helper| helper.join().expect("decompressing a frame panicked"))
            .chain([mine])
            .collect()
    })
}

/// Decompresses a component into an anonymous in-memory file and maps that
/// file. Wasmtime uses a mapped file's pages directly for the component's code
/// and its initial memory images. Deserializing from a byte slice instead
/// copies the component into new memory and copies each memory image again.
#[cfg(target_os = "linux")]
fn load_from_memory_file(
    engine: &Engine,
    path: &std::path::Path,
    compressed: &[u8],
    frames: &[Frame],
    size: usize,
) -> wasmtime::Result<Component> {
    use std::os::fd::{AsRawFd as _, FromRawFd as _};
    // SAFETY: the name is a valid C string, and `file` takes ownership of the
    // returned descriptor.
    let descriptor =
        unsafe { libc::memfd_create(c"polyroute-component".as_ptr(), libc::MFD_CLOEXEC) };
    if descriptor < 0 {
        wasmtime::bail!(
            "couldn't create memory for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        );
    }
    // SAFETY: `memfd_create` returned a new descriptor that nothing else owns.
    let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
    file.set_len(u64::try_from(size)?)?;
    if size > 0 {
        // SAFETY: maps the whole in-memory file, which only this function can
        // reach until it returns. The mapping is removed before the file is
        // deserialized.
        let mapping = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if mapping == libc::MAP_FAILED {
            wasmtime::bail!(
                "couldn't map memory for {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            );
        }
        struct Unmap(*mut libc::c_void, usize);
        impl Drop for Unmap {
            fn drop(&mut self) {
                // SAFETY: unmaps exactly the mapping created above, once.
                unsafe { libc::munmap(self.0, self.1) };
            }
        }
        let _unmap = Unmap(mapping, size);
        // SAFETY: the mapping is `size` writable bytes, and nothing else
        // refers to it while this slice lives.
        let output = unsafe { std::slice::from_raw_parts_mut(mapping.cast::<u8>(), size) };
        decompress_frames(path, compressed, frames, output)?;
    }
    // SAFETY: this private probe loads only the recorded trusted build
    // artifacts, and nothing writes to the in-memory file after this point.
    unsafe { Component::deserialize_file(engine, format!("/proc/self/fd/{}", file.as_raw_fd())) }
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
