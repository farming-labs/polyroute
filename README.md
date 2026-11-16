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

The built server is plain JavaScript. The machine that runs it needs Node, nothing else: no Rust, Go, or Python toolchain, no wasmtime, no extra packages.

> **Status:** early. Not published to npm yet.

## What it doesn't do

- **It doesn't make routes faster.** Routes run inside V8 here, with a fresh instance per request. Today that costs far more per request than a TypeScript route, and a Python route costs the most. See [Performance](#performance).
- **It isn't a framework.** It turns a route file into a fetch handler module. Routing, middleware, and serving belong to your framework or server.
- **Routes can't make outbound HTTP requests yet.** The build fails if a route needs them. The filesystem and sockets are linked so that language runtimes start, but there's nothing behind them. See [What a route can use](#what-a-route-can-use).

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

## How it works

1. The language's toolchain compiles the route to a WebAssembly component:
   - Rust: `cargo build --release --target wasm32-wasip2`. All Rust routes share one target directory under Vite's cache directory (`node_modules/.vite/polyroute`), so dependencies compile once.
   - Go: `go tool componentize-go build`.
   - Python: `componentize-py`, against the `polyroute:route/route` world in [`wit/`](packages/polyroute/wit).
   - Prebuilt components are read as they are.
2. [jco](https://github.com/bytecodealliance/jco) transpiles the component into JavaScript bindings and core Wasm modules. The output is cached by content hash.
3. The bindings and the base64-encoded core modules are bundled into your server build, together with polyroute's runtime.
4. At runtime, polyroute hosts the component in process with a small in-memory implementation of the WASI 0.2 interfaces an HTTP handler uses. Each request gets a fresh instance, so nothing leaks between requests, and a panic or exception can't poison later ones.

## What a route can use

| Available                                                             | Not yet                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| Request method, path, query, headers, and body                        | Outbound HTTP (`wasi:http/outgoing-handler`)            |
| Responses with any status (200 to 599), headers, and body             | Files: there are no preopened directories               |
| `stdout` and `stderr`, forwarded to `console.log` and `console.error` | Sockets: every call returns `access-denied`             |
| Clocks and timers                                                     | Environment variables (routes see an empty environment) |
| Random numbers                                                        | Response trailers                                       |

Language runtimes such as CPython and Go's `syscall` package import the filesystem and sockets at startup, whether or not the route uses them. polyroute links those interfaces with nothing behind them, so the route starts but can't open a file or a connection.

The build checks every other interface a route imports. If one isn't available, the build fails and names it:

```
`app/api/fetch/route.rs` imports `wasi:http/outgoing-handler`, which polyroute's
embedded runtime doesn't provide. ...
```

Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, and similar) are hidden from routes, and routes can't set them.

## Errors

Every error polyroute throws is a `PolyrouteError` with a stable `code`:

| Code                         | When                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `TOOLCHAIN_MISSING`          | `cargo`, `go`, or `componentize-py` isn't on `PATH`                     |
| `TARGET_MISSING`             | The `wasm32-wasip2` Rust target isn't installed                         |
| `BUILD_FAILED`               | The route doesn't compile; the message includes the toolchain's output  |
| `CLIENT_IMPORT`              | A route was imported from browser code                                  |
| `UNSUPPORTED_IMPORT`         | The route needs an interface the runtime doesn't provide                |
| `MISSING_HANDLER`            | The component doesn't export `wasi:http/incoming-handler`               |
| `ROUTE_INSTANTIATION_FAILED` | The compiled route couldn't be instantiated                             |
| `ROUTE_TRAPPED`              | The route panicked, raised, or trapped; the message includes its stderr |
| `ROUTE_NO_RESPONSE`          | The route returned without responding                                   |
| `ROUTE_ERROR`                | The route responded with a `wasi:http` error code                       |
| `ROUTE_INVALID_RESPONSE`     | The response can't be sent, for example an unfinished body              |

A trapped request throws from `fetch`, so your framework's error handling decides what the client sees.

## Performance

Measured on the example's production build, with all routes served by one Node process:

| Route                                           | Requests/s |    p50 |    p99 |
| ----------------------------------------------- | ---------: | -----: | -----: |
| TypeScript `GET /api/hello`                     |     28,459 |   0 ms |   1 ms |
| Rust `GET /api/primes?limit=2` (almost no work) |        864 |   8 ms |  43 ms |
| Go `GET /api/slug?text=hello`                   |        146 |  56 ms | 196 ms |
| Python `POST /api/stats`                        |         76 | 111 ms | 382 ms |

Apple M1, Node 24.21.0, autocannon with 10 connections, three interleaved 5-second runs per route, median shown. With 10 requests in flight on one event loop, latency includes queueing: the time spent on each request is roughly one second divided by the requests per second, about 1.2 ms for Rust, 7 ms for Go, and 13 ms for Python. Two back-to-back runs of the TypeScript route matched in this session, but an earlier session measured 34% between such runs, so read these as rough. The gaps between languages are not.

Most of the cost comes from the fresh instance per request, and it grows with the size of the component:

| Route  | Component size |
| ------ | -------------: |
| Rust   |        254 KiB |
| Go     |      6,913 KiB |
| Python |     18,516 KiB |

Profiling a Rust route in process showed about 140 µs to instantiate the component and about 325 µs for the first call into it. A Python component carries an interpreter and a snapshot of its heap, so each instance copies far more memory.

So use polyroute today when you want to write a route in another language and deploy it wherever Node runs, not for speed. Running components under wasmtime, where cold starts and multicore throughput are strong, is a planned addition.

## Limits

- Rust routes build with wstd 0.5, Go routes with componentize-go 0.5.3 and go-wasi 0.1.2, and Python routes with componentize-py 0.25.
- Python routes can import the standard library and modules next to the route. Third-party packages are untested; componentize-py picks up the active virtual environment's `site-packages`, so build in a clean one.
- Request and response bodies are buffered in memory. Streaming isn't supported yet.
- A route that sleeps blocks the Node event loop while it sleeps.
- Core modules are inlined as base64. A Python route adds about 24 MB to the server bundle, and a Go route about 9 MB.
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
```

## License

MIT. The WASI interface files in [`packages/polyroute/wit/deps`](packages/polyroute/wit/deps) are Apache-2.0 WITH LLVM-exception.
