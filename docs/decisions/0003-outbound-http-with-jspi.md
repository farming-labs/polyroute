# 0003: Outbound HTTP through JSPI, for allowed hosts only

Status: accepted, 2026-11-16

## Context

A route that calls an API sends the request with its language's own client: `wstd::http::Client` in Rust, or `net/http` with `wasihttp.DefaultClient` in Go. Both are built on `wasi:http/outgoing-handler`. `handle` starts the request and returns a `future-incoming-response`, and the client then waits on the future's pollable through `wasi:io/poll`.

polyroute's host is synchronous. A route's `handle` export runs to completion inside one JavaScript call, and `poll` waits for timers with `Atomics.wait`, which blocks the thread. A blocking wait for an HTTP response would have stopped every other request in the process, and it couldn't have finished anyway: `fetch` needs the event loop that the wait blocks. So the build rejected any route that imported `outgoing-handler`.

## Decision

- **JSPI, only where it's needed.** jco can transpile a component with `asyncMode: "jspi"`. Imports listed in `asyncImports` may then return a promise, and V8 suspends the guest's stack until it settles. Exports listed in `asyncExports` return a promise. polyroute transpiles a route a second time, with `wasi:io/poll#poll` and `wasi:io/poll#[method]pollable.block` as suspending imports and `wasi:http/incoming-handler#handle` as a promising export, when the first pass shows it imports `outgoing-handler`. Every other route is transpiled and run exactly as before.
- **`fetch` behind the handler.** The host buffers the request body the guest writes. The guest usually writes it after `handle` returns, so the request goes out once the body is finished. The host then reads the whole response before the future becomes ready, so streams stay synchronous, as they are for incoming requests. The future's pollable is ready once that read settles, and `poll` and `block` return a promise until it is.
- **Allowed hosts only.** Nothing is allowed by default. `polyroute({ outbound: { allow: [...] } })` lists hostnames, hostnames with a port, `*.` subdomain wildcards, or `"*"`. A route that imports `outgoing-handler` fails to build until `outbound` is set, with `OUTBOUND_NOT_ALLOWED`. A request to a host that isn't allowed fails with the `wasi:http` error `HTTP-request-denied`.
- **Errors go through the future.** wstd's `Client::send` unwraps the result of `outgoing-handler.handle`, so an error returned from `handle` itself would trap the route. The host always returns a future, and a denied host, an invalid URI, or a network failure becomes the future's error. The route can handle it like any other failed request.
- **One instance per waiting request.** A route that suspends can have several requests in flight. A reused instance still serves one request at a time, so the runtime keeps a pool: a request takes an idle instance or starts a new one, up to 32 per route, and further requests wait for one to be released. A route that never suspends never has more than one, which is the behavior [0001](0001-reuse-route-instances.md) describes.
- **Timers suspend too.** In a route transpiled with JSPI, a pollable from `monotonic-clock` waits with `setTimeout` instead of `Atomics.wait`.
- **Requests end with the request that sent them.** When the route has answered, the host aborts any of its outbound requests that are still running.

## Why JSPI

The alternatives each cost more:

- **Asyncify** rewrites the guest's Wasm to unwind and rewind its own stack. It grows the binary and slows every call, and it has to run on the component's core modules, after the language's toolchain.
- **A worker per request**, with the main thread doing the I/O, keeps `Atomics.wait` but moves the guest off the main thread. Every request and response would cross threads, and instances couldn't be shared.
- **jco's component-model async (WASI 0.3)** needs guests built for it. wstd 0.5 and go-wasi 0.1.2 target WASI 0.2.

JSPI needs no change to the guest and none to routes that don't call out. Its cost is limited to the routes that use it.

## Consequences

- A route that sends requests needs a JavaScript runtime with `WebAssembly.Suspending`. Node 24 has it. Node 22 doesn't, even with `--experimental-wasm-jspi`, so on Node 22 that route fails with `UNSUPPORTED_RUNTIME` and every other route keeps working. Building such a route doesn't need JSPI.
- jco's JSPI output marks the suspending imports `manuallyAsync`, and [0002](0002-skip-sync-task-bookkeeping.md)'s rewrite leaves a route alone when any import is marked that way. So every host call in a route that sends requests goes through jco's async task bookkeeping, and costs what it did before 0002.
- Response bodies are buffered in memory, like every other body polyroute handles, so a route can't stream a large or endless response.
- `fetch` decodes gzip, deflate, Brotli, and zstd responses but keeps their `content-encoding` and `content-length`. The host drops those two headers when `fetch` decoded the body, and asks for an uncompressed response unless the route set `accept-encoding` itself.
- `fetch` doesn't follow redirects for the route. A client that follows them, such as Go's `http.Client`, sends a new request for each hop, and each is checked against the allowed hosts.
- `connect-timeout` and `first-byte-timeout` together limit the wait for the response headers, since `fetch` doesn't report when the connection was made. `between-bytes-timeout` limits each wait for the next chunk of the body.
- Python routes can't send requests yet. `urllib` and `requests` open sockets, which polyroute denies, and the route world in `wit/` doesn't import `outgoing-handler`.
