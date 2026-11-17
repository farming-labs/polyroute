# polyroute

**Write web routes in Rust, Go, or Python and serve them as standard `fetch` handlers.**

polyroute is a Vite plugin. Put a `route.rs`, `route.go`, or `route.py` next to your `route.ts`, and the import becomes a module that exports `(request: Request) => Promise<Response>`, the same shape as a TypeScript route handler. The route compiles to a WebAssembly component, which polyroute transpiles to JavaScript and bundles into your server build. A component built in any other language works too, imported as a prebuilt `.wasm` file.

```
app/api/
  hello/route.ts     export function GET(request) { ... }
  primes/route.rs    #[wstd::http_server] async fn main(request, responder) { ... }
  slug/route.go      wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) { ... })
  stats/route.py     def POST(request: Request) -> Response: ...
```

The build writes a plain JavaScript server and, next to it, a `polyroute/` folder with each route's WebAssembly. Deploy both. The machine that runs them needs Node, nothing else: no Rust, Go, or Python toolchain, no wasmtime, no extra packages.

> **Status:** early. Not published to npm yet.

## What it doesn't do

- **It doesn't make light routes faster than TypeScript.** Routes run as WebAssembly inside V8, and every call between a route and its host goes through jco's JavaScript glue. A Rust route that does almost no work costs about 1.8× a TypeScript one per request, and Go and Python about 4×. Routes that do real work can come out ahead. See [Performance](#performance).
- **It isn't a framework.** It turns a route file into a fetch handler module. Routing, middleware, and serving belong to your framework or server.
- **Routes reach the network only through HTTP, and only to hosts you allow.** A route that sends requests fails to build until you list the hosts it may call. The filesystem and sockets are linked so that language runtimes start, but there's nothing behind them. See [Outbound requests](#outbound-requests) and [What a route can use](#what-a-route-can-use).

## Quick start

You need Node 22 or newer and Vite 8, plus the toolchain for each language you write routes in:

| Language  | Route file                 | Toolchain                                                                                                  |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Rust      | `route.rs`                 | Rust with the `wasm32-wasip2` target: `rustup target add wasm32-wasip2`                                    |
| Go        | `route.go` with a `go.mod` | Go 1.27.1 or newer                                                                                         |
| Python    | `route.py`                 | [componentize-py](https://github.com/bytecodealliance/componentize-py) 0.25: `pip install componentize-py` |
| Any other | `route.wasm`               | Whatever builds a `wasi:http` component for that language                                                  |

The machine that builds needs these. The machine that runs the build output doesn't.

Add the plugin:

```ts
// vite.config.ts
import { polyroute } from "@farming-labs/polyroute";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [polyroute()],
});
```

Import a route from server code like any other module:

```ts
import greet from "./app/api/greet/route.rs";

const response = await greet.fetch(new Request("http://localhost/api/greet"));
```

For types, reference the module declarations once:

```ts
/// <reference types="@farming-labs/polyroute/modules" />
```

[`examples/polyglot`](examples/polyglot) is a complete app: one route in each of TypeScript, Rust, Go, and Python behind a small file router, with a dev server and a production build.

## Languages

### Rust

Write the route with [wstd](https://crates.io/crates/wstd):

```rust
// app/api/greet/route.rs
use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{IntoBody, Request, Response};

#[wstd::http_server]
async fn main(request: Request<IncomingBody>, responder: Responder) -> Finished {
    let path = request.uri().path().to_string();
    let response = Response::builder()
        .header("content-type", "text/plain")
        .body(format!("hello from Rust at {path}").into_body())
        .unwrap();
    responder.respond(response).await
}
```

A lone `route.rs` gets a generated manifest that depends on `wstd = "0.5"`. To add crates, put a `Cargo.toml` next to the route and declare the route as a binary:

```toml
[package]
name = "search-route"
version = "0.0.0"
edition = "2024"

[[bin]]
name = "route"
path = "route.rs"

[dependencies]
wstd = "0.5"
serde_json = "1"

[workspace]
```

polyroute builds that crate as it is. In dev, editing any of its source files rebuilds the route.

### Go

A Go route is a `main` package with its own module. Register a standard `net/http` handler with [`wasihttp`](https://github.com/bytecodealliance/go-wasi):

```go
// app/api/greet/route.go
package main

import (
	"fmt"
	"net/http"

	"go.bytecodealliance.org/wasi/wasihttp"
)

func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "hello from Go at %s\n", r.URL.Path)
	})
}

func main() {}
```

Create the module next to the route. polyroute builds with [componentize-go](https://github.com/bytecodealliance/componentize-go), which runs as a Go tool of the module:

```bash
go mod init example.com/greet
go get go.bytecodealliance.org/wasi@v0.1.2
go get -tool github.com/bytecodealliance/componentize-go@v0.5.3
```

The route needs its own `go.mod` because componentize-go only finds its WIT when it runs from the module root. It also only looks in modules that are already downloaded, so polyroute runs `go mod download` in the route's module before each build. The first build needs access to the Go module proxy, or a module cache that already has the route's dependencies. Every `.go` file in the route's directory is part of the route, and editing any of them, or `go.mod`, rebuilds it in dev.

#### Go on Windows

componentize-go's Go wrapper downloads its binary the first time it runs. On Windows that download fails with a 404: the wrapper asks for `componentize-go-windows-amd64.tar.gz`, but releases only ship a `.zip`. Until that's fixed upstream, put the binary in the wrapper's cache yourself, once per machine, in PowerShell:

```powershell
$version = "v0.5.3"
$sha256 = "253aec144b983c8d3c5d7fbfacc2e429e6beaa23b75f22cd0c8bb35ade66d06a"
$cache = Join-Path $env:LOCALAPPDATA "bytecodealliance\componentize-go"
$zip = Join-Path $env:TEMP "componentize-go-$version-windows-amd64.zip"
Invoke-WebRequest "https://github.com/bytecodealliance/componentize-go/releases/download/$version/componentize-go-windows-amd64.zip" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sha256) { throw "$zip doesn't match the release checksum." }
Expand-Archive $zip -DestinationPath "$cache\bin" -Force
Copy-Item "$cache\bin\componentize-go.exe" "$cache\bin\componentize-go" -Force
Set-Content "$cache\version.txt" $version -NoNewline
```

The wrapper skips the download when `bin\componentize-go` exists and `version.txt` names its release, and it then runs `componentize-go.exe`. The checksum is the one in the release's `checksums.txt`. CI runs the same steps on its Windows runners.

### Python

A Python route defines a function per HTTP method. Each takes a `Request` and returns a `Response`:

```python
# app/api/greet/route.py
from polyroute import Request, Response


def GET(request: Request) -> Response:
    return Response(f"hello from Python at {request.path}\n")


def POST(request: Request) -> Response:
    return Response.json({"received": request.json()}, status=201)
```

The `polyroute` module comes with the package. It provides:

- `Request`, with `method`, `url`, `path`, `query` (a dict of the first value per key), `headers` (a dict with lowercase names), `body` (bytes), `text()`, and `json()`.
- `Response(body=None, status=200, headers=None)`, where `body` may be `str`, `bytes`, or `None`. There's also `Response.json(data, status=200, headers=None)`.

A method the route doesn't define gets `405` with an `allow` header, and `HEAD` falls back to `GET`.

Modules next to the route can be imported, as can the standard library. componentize-py imports the route at build time and snapshots it, so top-level code runs once, during the build. CPython 3.14 runs inside the component, whatever Python installed componentize-py.

### Any other language: a prebuilt component

Import a `.wasm` file that is a component exporting `wasi:http/incoming-handler@0.2`, and it gets the same exports as any other route. That's the way in for languages polyroute doesn't build itself, and for components built elsewhere in your pipeline. polyroute checks the component's imports at build time, just like a route it built itself. So far only components from the toolchains above have been tested this way.

Core Wasm modules aren't components, so polyroute leaves them, and imports with a Vite query such as `?init` or `?url`, to Vite.

## What a route module exports

| Export                                                     | Value                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `default`                                                  | `{ route, fetch }`, where `route` is the file's path                     |
| `fetch`                                                    | The fetch handler                                                        |
| `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | The same fetch handler, for frameworks that look up a handler per method |

Every method reaches the route, and the route decides what to do with it.

## Instances

Each route keeps one instance of its component and hands it every request, one at a time, like a long-running server process. A route that [sends requests](#outbound-requests) can have several requests waiting at once, so it gets up to 32 instances, one per request in flight:

- **Global state persists between requests:** a `static` in Rust, a package-level variable in Go, a module global in Python. Use it for caches and lookup tables, and don't leave one request's data in it for the next.
- **A trap throws the instance away.** After a panic or an uncaught exception, the next request starts a new instance, so a trap can't affect later requests.
- **Output belongs to its request.** What a route writes to stdout and stderr goes to the console. The stderr in a `ROUTE_TRAPPED` error is only from the request that trapped.
- **An instance's memory stays allocated** while the process runs: once per route, or once per instance a route that sends requests has started.
- **A Go instance is replaced after 1,000 requests.** Go's WASI bindings (`go.bytecodealliance.org/pkg` v0.4.1) pin every buffer the host writes into the guest and never release it, so a Go instance's memory grows with every request. A package-level variable in a Go route lasts at most 1,000 requests.

For strict isolation, give every request a fresh instance instead:

```ts
polyroute({ instances: "per-request" });
```

| `instances`         | Instances       | State between requests | Cost per request                              |
| ------------------- | --------------- | ---------------------- | --------------------------------------------- |
| `"reuse"` (default) | One per route   | Persists               | The handler                                   |
| `"per-request"`     | One per request | None                   | Instantiating the component, then the handler |

[docs/decisions/0001-reuse-route-instances.md](docs/decisions/0001-reuse-route-instances.md) explains the choice.

## Outbound requests

A route can call other services with its language's own HTTP client. Allow the hosts it may call:

```ts
polyroute({ outbound: { allow: ["api.github.com", "*.example.com", "localhost:8787"] } });
```

| Entry              | Allows                                       |
| ------------------ | -------------------------------------------- |
| `"api.github.com"` | That host, on any port                       |
| `"localhost:8787"` | That host, on that port only                 |
| `"*.example.com"`  | Its subdomains, but not `example.com` itself |
| `"*"`              | Any host                                     |

Nothing is allowed by default. A route that sends requests fails to build with `OUTBOUND_NOT_ALLOWED` until `outbound` is set, and a request to a host that isn't listed fails with the `wasi:http` error `HTTP-request-denied`. The route gets that error from its client, as it would a refused connection, and can answer however it likes.

| Language         | Client                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Rust             | `wstd::http::Client`                                                  |
| Go               | `net/http`, with `wasihttp.DefaultClient` or a `wasihttp.Transport`   |
| Prebuilt `.wasm` | Anything built on `wasi:http/outgoing-handler@0.2`                    |
| Python           | Not yet: `urllib` and `requests` open sockets, which polyroute denies |

```rust
// app/api/user/route.rs
use wstd::http::body::IncomingBody;
use wstd::http::server::{Finished, Responder};
use wstd::http::{Client, IntoBody, Request, Response, StatusCode};

#[wstd::http_server]
async fn main(_request: Request<IncomingBody>, responder: Responder) -> Finished {
    let upstream = Request::get("https://api.github.com/users/octocat")
        .header("user-agent", "polyroute")
        .body(wstd::io::empty())
        .unwrap();
    let response = match Client::new().send(upstream).await {
        Ok(mut user) => {
            let body = user.body_mut().bytes().await.unwrap_or_default();
            Response::new(body.into_body())
        }
        Err(error) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(format!("{error:?}").into_body())
            .unwrap(),
    };
    responder.respond(response).await
}
```

While a route waits for a response, the rest of the server keeps running. polyroute transpiles a route that imports `wasi:http/outgoing-handler` with [JSPI](https://v8.dev/blog/jspi), which lets V8 suspend the route's WebAssembly while JavaScript awaits a `fetch`. Its timers suspend it the same way. Routes that don't send requests are transpiled and run exactly as before. [docs/decisions/0003-outbound-http-with-jspi.md](docs/decisions/0003-outbound-http-with-jspi.md) explains the design.

- **It needs Node 24 or later.** Node 22 has no JSPI, so there a route that sends requests fails with `UNSUPPORTED_RUNTIME`, and every other route keeps working.
- **It costs more than `fetch` from TypeScript.** Over HTTP (`pnpm bench`), the example's relay route, a Rust route that sends one request to the TypeScript route on the same server, served 629 requests/s, against 11,525 for the TypeScript route and 7,188 for a Rust route that sends none. In-process, a Rust route that forwards a request used 1,058 µs of CPU per request and a Go route 2,307 µs, against 164 µs for a TypeScript handler calling `fetch` (median of 30 interleaved rounds). Suspending the route costs under a microsecond. The rest is the route's own work: more than 45 host calls per forwarded request, each through jco's glue. Both runs were on an Apple M1 busy with other work, so read the numbers as rough.
- **The route pays for JSPI on every request**, including ones that send nothing: a minimal Rust route took 116 µs a request in-process transpiled with JSPI, against 47 µs without.
- **Bodies are buffered.** The request is sent once the route has written all of its body, and the route sees the response once all of it has arrived.
- **Compression is undone for the route.** polyroute asks for an uncompressed response unless the route sets `accept-encoding`. When `fetch` decodes a compressed response anyway, polyroute drops `content-encoding` and `content-length`, which describe the compressed bytes.
- **Redirects aren't followed for the route.** A client that follows them, such as Go's `http.Client`, sends a request per hop, and each hop is checked against `allow`.
- **Timeouts.** `connect-timeout` and `first-byte-timeout` from `request-options` together limit the wait for the response headers, and `between-bytes-timeout` limits each wait for more of the body. Requests still running when the route's handler returns are cancelled.

## How it works

1. The language's toolchain compiles the route to a WebAssembly component:
   - Rust: `cargo build --release --target wasm32-wasip2`. All Rust routes share one target directory under Vite's cache directory (`node_modules/.vite/polyroute`), so dependencies compile once.
   - Go: `go tool componentize-go build`.
   - Python: `componentize-py`, against the `polyroute:route/route` world in [`wit/`](packages/polyroute/wit).
   - Prebuilt components are read as they are.
2. [jco](https://github.com/bytecodealliance/jco) transpiles the component into JavaScript bindings and core Wasm modules. polyroute rewrites the bindings so calls into its synchronous host skip jco's async task bookkeeping ([why that's safe](docs/decisions/0002-skip-sync-task-bookkeeping.md)). A route that sends requests is transpiled with JSPI instead, and the rewrite doesn't apply to it yet (see [Outbound requests](#outbound-requests)). The output is cached by content hash.
3. The bindings are bundled into your server build, together with polyroute's runtime. The core modules are written to a `polyroute/` folder next to the chunk that loads them, so starting the server doesn't parse any route's WebAssembly. In dev, they're inlined instead.
4. At runtime, polyroute hosts the component in process with a small in-memory implementation of the WASI 0.2 interfaces an HTTP handler uses. The first request to a route instantiates its component, and later requests reuse that instance. See [Instances](#instances).

## What a route can use

| Available                                                                      | Not yet                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Request method, path, query, headers, and body                                 | Files: there are no preopened directories               |
| Responses with any status (200 to 599), headers, and body                      | Sockets: every call returns `access-denied`             |
| `stdout` and `stderr`, forwarded to `console.log` and `console.error`          | Environment variables (routes see an empty environment) |
| Clocks and timers                                                              | Request and response trailers                           |
| Random numbers                                                                 |                                                         |
| HTTP requests to hosts you allow (see [Outbound requests](#outbound-requests)) |                                                         |

Language runtimes such as CPython and Go's `syscall` package import the filesystem and sockets at startup, whether or not the route uses them. polyroute links those interfaces with nothing behind them, so the route starts but can't open a file or a connection.

The build checks every other interface a route imports. If one isn't available, the build fails and names it:

```
`app/api/cache/route.rs` imports `wasi:keyvalue/store`, which polyroute's
embedded runtime doesn't provide. ...
```

Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, and similar) are hidden from routes, and routes can't set them.

## Errors

Every error polyroute throws is a `PolyrouteError` with a stable `code`:

| Code                         | When                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `INVALID_OPTIONS`            | `polyroute()` got an option value it doesn't accept                     |
| `TOOLCHAIN_MISSING`          | `cargo`, `go`, or `componentize-py` isn't on `PATH`                     |
| `TARGET_MISSING`             | The `wasm32-wasip2` Rust target isn't installed                         |
| `BUILD_FAILED`               | The route doesn't compile; the message includes the toolchain's output  |
| `CLIENT_IMPORT`              | A route was imported from browser code                                  |
| `UNSUPPORTED_IMPORT`         | The route needs an interface the runtime doesn't provide                |
| `OUTBOUND_NOT_ALLOWED`       | The route sends HTTP requests, but `outbound` isn't set                 |
| `MISSING_HANDLER`            | The component doesn't export `wasi:http/incoming-handler`               |
| `ROUTE_INSTANTIATION_FAILED` | The compiled route couldn't be instantiated                             |
| `UNSUPPORTED_RUNTIME`        | The route sends HTTP requests, and the runtime has no JSPI (Node < 24)  |
| `ROUTE_TRAPPED`              | The route panicked, raised, or trapped; the message includes its stderr |
| `ROUTE_NO_RESPONSE`          | The route returned without responding                                   |
| `ROUTE_ERROR`                | The route responded with a `wasi:http` error code                       |
| `ROUTE_INVALID_RESPONSE`     | The response can't be sent, for example an unfinished body              |

A trapped request throws from `fetch`, so your framework's error handling decides what the client sees.

## Performance

Measured with `pnpm bench` on the example's production build, with all routes served by one Node process and every response body checked:

| Route                                           | Requests/s |     p50 |    p99 | With a fresh instance per request |
| ----------------------------------------------- | ---------: | ------: | -----: | --------------------------------: |
| TypeScript `GET /api/hello`                     |     25,603 | 0.33 ms | 1.8 ms |                                 – |
| Rust `GET /api/primes?limit=2` (almost no work) |     14,004 | 0.53 ms | 3.3 ms |                             2,321 |
| Rust `GET /api/primes?limit=10000`              |      6,706 |  1.2 ms | 3.6 ms |                             2,028 |
| Go `GET /api/slug?text=hello`                   |      5,785 |  1.3 ms | 6.1 ms |                               400 |
| Python `POST /api/stats`                        |      6,240 |  1.2 ms | 5.9 ms |                               108 |

Apple M1, Node 24.21.0, 10 connections, three 4-second rounds per route after a 1-second warmup, median shown. The first columns come from rounds alternated with the build from before the bindings rewrite described below, which served 11,167, 5,383, 3,731, and 4,440 requests/s on the four non-TypeScript rows. The TypeScript route, which the rewrite doesn't touch, differed by 2.4% between the two builds, and single rounds varied by up to 25%, so read the numbers as rough. The last column is the same build with `instances: "per-request"`, measured in a second run. The Go row includes replacing its instance every 1,000 requests (see [Instances](#instances)).

Reusing the instance removes the biggest cost, which grew with the component: 254 KiB for Rust, 6.9 MB for Go, and 18.5 MB for Python, an interpreter plus a heap snapshot. A non-TypeScript route still costs more per request than a TypeScript one, about 1.8× for Rust and 4× for Go and Python here. Every call between the route and its host goes through jco's glue. jco runs each call through its async task runtime, even when both sides are synchronous, so polyroute rewrites the bindings to skip that for its synchronous host ([0002](docs/decisions/0002-skip-sync-task-bookkeeping.md)). That halved the Rust route's cost measured in-process, from 45 µs to 24 µs a request. A CPU profile of the rewritten route still puts 41% of its time in jco's bindings and 7% in the route's own WebAssembly. Most of the rest is undici's `Request` and `Response`, polyroute's host, and V8 itself. Over HTTP, Node's server adds the same cost to every route, TypeScript included.

### Cold start

`node scripts/bench.mjs --cold` starts a new server for every sample and times its first response, which is what the first request to a serverless instance pays:

| Route                   | Core modules inlined (before) | Core modules as files |
| ----------------------- | ----------------------------: | --------------------: |
| TypeScript              |                        324 ms |                139 ms |
| Rust (little work)      |                        349 ms |                168 ms |
| Rust (primes to 10,000) |                        358 ms |                165 ms |
| Go                      |                        433 ms |                253 ms |
| Python                  |                        486 ms |                235 ms |

Apple M1, Node 24.21.0, 10 runs per route alternating between the two builds, median shown. Other processes kept the load average around 20 during the run, so the absolute numbers are high. In a quieter run, a 3-line Node `http` server answered its first request in about 50 ms. The server bundle used to carry every route's core modules as base64, 35 MB of a 37.4 MB `server.js`, and every cold start parsed all of it, TypeScript routes included. Now `server.js` is 2.2 MB, and a route reads its own files on its first request. What's left includes about 2 MB of jco bindings, one copy per route, which a server that imports all its routes up front parses when it starts.

On real work, the gap goes the other way. Counting primes below 100,000, the Rust route served 439 requests/s, the same algorithm in a plain Node server 245, and `wasmtime serve`, which runs the same component across several threads, 1,506. Those are single 5-second runs with 10 connections.

So use polyroute when you want to write a route in another language and deploy it wherever Node runs. Running components under wasmtime, where cold starts and multicore throughput are strong, is a planned addition.

## Limits

- Rust routes build with wstd 0.5, Go routes with componentize-go 0.5.3 and go-wasi 0.1.2, and Python routes with componentize-py 0.25.
- Python routes can import the standard library and modules next to the route. Third-party packages are untested; componentize-py picks up the active virtual environment's `site-packages`, so build in a clean one.
- Request and response bodies are buffered in memory. Streaming isn't supported yet.
- A route that sleeps blocks the Node event loop while it sleeps, unless it [sends requests](#outbound-requests), which makes its timers suspend it instead.
- Core modules deploy as files next to the server: about 19 MB for a Python route, 7 MB for a Go route, and 250 KB for a Rust route. A deploy that copies `server.js` without its `polyroute/` folder fails with `ROUTE_INSTANTIATION_FAILED` on each route's first request.
- Each route bundles its own copy of jco's glue code, about 400 KB before compression.
- The first build of each language is slow: Rust compiles wstd, and componentize-go downloads itself on first use. Later builds are incremental.
- Tested on macOS arm64 with Node 24. Windows and Linux run in CI but haven't been verified by hand. Bun, Deno, and Cloudflare Workers are untested; Workers can't compile Wasm from bytes at runtime, so routes won't load there as-is.

## Development

The tests build real routes, so they need every toolchain from the [quick start](#quick-start).

```bash
pnpm install
pnpm test           # unit, production build, and dev server tests
pnpm smoke          # build the example and check every route over HTTP
pnpm smoke:packed   # the same, installed from a packed tarball outside the workspace
pnpm bench          # measure every route of the example's production build
```

## License

MIT. The WASI interface files in [`packages/polyroute/wit/deps`](packages/polyroute/wit/deps) are Apache-2.0 WITH LLVM-exception.
