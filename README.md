# polyroute

**Write web routes in other languages and serve them as standard `fetch` handlers.**

polyroute is a Vite plugin. Put a `route.rs` next to your `route.ts`, and the import becomes a module that exports `(request: Request) => Promise<Response>`, the same shape as a TypeScript route handler. The Rust code compiles to a WebAssembly component, which polyroute transpiles to JavaScript and bundles into your server build. A component built in any other language works too, imported as a prebuilt `.wasm` file.

```
app/api/
  hello/route.ts     export function GET(request) { ... }
  primes/route.rs    #[wstd::http_server] async fn main(request, responder) { ... }
```

The built server is plain JavaScript. The machine that runs it needs Node, nothing else: no Rust toolchain, no wasmtime, no extra packages.

> **Status:** early. polyroute builds Rust routes from source, and routes in other languages can come in as prebuilt components. The in-process runtime described below is the only way to run a route. Not published to npm yet.

## What it doesn't do

- **It doesn't make routes faster.** A Rust route runs inside V8 here, with a fresh instance per request. Today that costs far more per request than a TypeScript route. See [Performance](#performance).
- **It isn't a framework.** It turns a route file into a fetch handler module. Routing, middleware, and serving belong to your framework or server.
- **Routes can't make outbound HTTP requests yet.** The build fails if a route needs them. The filesystem and sockets are linked so that language runtimes start, but there's nothing behind them. See [What a route can use](#what-a-route-can-use).

## Quick start

You need Node 22 or newer, Vite 8, and Rust with the `wasm32-wasip2` target:

```bash
rustup target add wasm32-wasip2
```

Add the plugin:

```ts
// vite.config.ts
import { polyroute } from "@farming-labs/polyroute";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [polyroute()],
});
```

Write a route with [wstd](https://crates.io/crates/wstd):

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

Import it from server code like any other module:

```ts
import greet from "./app/api/greet/route.rs";

const response = await greet.fetch(new Request("http://localhost/api/greet"));
```

For types, reference the module declarations once:

```ts
/// <reference types="@farming-labs/polyroute/modules" />
```

[`examples/rust-route`](examples/rust-route) is a complete app: a TypeScript route and two Rust routes behind a small file router, with a dev server and a production build.

## What a route module exports

| Export                                                     | Value                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `default`                                                  | `{ route, fetch }`, where `route` is the file's path                     |
| `fetch`                                                    | The fetch handler                                                        |
| `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | The same fetch handler, for frameworks that look up a handler per method |

Every method reaches the route, and the route decides what to do with it.

## Dependencies

A lone `route.rs` gets a generated manifest that depends on `wstd = "0.5"`.

To add crates, put a `Cargo.toml` next to the route and declare the route as a binary:

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

## Prebuilt components

Import a `.wasm` file that is a component exporting `wasi:http/incoming-handler@0.2`, and it gets the same exports as a `.rs` route. That's the way in for languages polyroute doesn't build itself, and for components built elsewhere in your pipeline. polyroute checks the component's imports at build time, just like a route it built itself. So far only components built by cargo have been tested this way.

Core Wasm modules aren't components, so polyroute leaves them, and imports with a Vite query such as `?init` or `?url`, to Vite.

## How it works

1. `cargo build --release --target wasm32-wasip2` compiles a Rust route. All Rust routes share one target directory under Vite's cache directory (`node_modules/.vite/polyroute`), so dependencies compile once. A prebuilt component is read as it is.
2. [jco](https://github.com/bytecodealliance/jco) transpiles the component into JavaScript bindings and core Wasm modules. The output is cached by content hash.
3. The bindings and the base64-encoded core modules are bundled into your server build, together with polyroute's runtime.
4. At runtime, polyroute hosts the component in process with a small in-memory implementation of the WASI 0.2 interfaces an HTTP handler uses. Each request gets a fresh instance, so nothing leaks between requests and a panic can't poison later ones.

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
| `TOOLCHAIN_MISSING`          | `cargo` isn't on `PATH`                                                 |
| `TARGET_MISSING`             | The `wasm32-wasip2` target isn't installed                              |
| `BUILD_FAILED`               | The route doesn't compile; the message includes cargo's diagnostics     |
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

| Route                                       | Requests/s |   p50 |   p99 |
| ------------------------------------------- | ---------: | ----: | ----: |
| TypeScript `/api/hello`                     |     33,838 |  0 ms |  0 ms |
| Rust `/api/primes?limit=2` (almost no work) |      1,178 |  6 ms | 23 ms |
| Rust `/api/primes?limit=10000`              |        774 | 10 ms | 46 ms |

Apple M1, Node 24.21.0, autocannon with 10 connections, three interleaved 5-second runs per route, median shown. Two back-to-back runs of the TypeScript route differed by 34%, so read these as rough. The gap is not.

Most of the cost comes from the fresh instance per request. Profiling a similar route in process showed about 140 µs to instantiate the component and about 325 µs for the first call into it. Each instance also allocates about 1 MiB of linear memory, which adds garbage collection pauses under load.

So use polyroute today when you want to write a route in Rust and deploy it wherever Node runs, not for speed. Running components under wasmtime, where cold starts and multicore throughput are strong, is a planned addition.

## Limits

- Rust routes build with wstd 0.5 and `wasm32-wasip2`.
- Request and response bodies are buffered in memory. Streaming isn't supported yet.
- A route that sleeps blocks the Node event loop while it sleeps.
- Each route bundles its own copy of jco's glue code, about 400 KB before compression.
- The first build compiles wstd and its dependencies, which takes a while. Later builds are incremental.
- Tested on macOS arm64 with Node 24. Windows and Linux run in CI but haven't been verified by hand. Bun, Deno, and Cloudflare Workers are untested; Workers can't compile Wasm from bytes at runtime, so routes won't load there as-is.

## Development

```bash
pnpm install
pnpm test           # unit, production build, and dev server tests (needs cargo)
pnpm smoke          # build the example and check every route over HTTP
pnpm smoke:packed   # the same, installed from a packed tarball outside the workspace
```

## License

MIT
