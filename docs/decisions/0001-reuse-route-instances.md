# 0001: Reuse one instance per route by default

Status: accepted, 2026-11-16

## Context

polyroute used to instantiate a route's component for every request and stop it afterwards. That gave strong isolation: no state survived a request, and a trap couldn't affect the next one. It also made every request pay for a full instantiation. That means compiling nothing, since core modules are compiled once, but allocating linear memory, copying data segments, and running the language runtime's startup. That cost grows with the component: about 250 KiB for a Rust route, 6.9 MB for Go, and 18.5 MB for Python, which carries an interpreter and a heap snapshot.

On the example app, the fresh instance dominated every non-TypeScript route. The measurements are in the README's Performance section and in the PR that made this change.

## Decision

`polyroute({ instances })` picks how requests map to instances:

- `"reuse"`, the default: each route keeps one instance and hands it every request, one at a time.
- `"per-request"`: the previous behavior.

With `"reuse"`:

- **One request at a time.** The exported `handle` runs synchronously, and nothing between taking the instance and returning from `handle` awaits. So two requests never run inside one instance at the same time, and the runtime needs no lock or pool.
- **Output follows the request.** A guest keeps the stdout and stderr streams it got at startup, so the host gives it relay sinks and points them at the current request's output for the duration of `handle`. A `ROUTE_TRAPPED` error carries only that request's stderr.
- **A trap retires the instance.** The runtime stops it with jco's `_util.stop()`, and the next request starts a new one. Requests that were already waiting for the retired instance start a new one too.
- **Failed starts aren't cached.** If instantiation fails, the next request tries again.

## Why reuse is the default

A Rust, Go, or Python developer expects a server process whose globals live across requests. Mainstream serverless runtimes reuse warm instances the same way, including Lambda execution environments, Workers isolates, and Vercel functions. Per-request isolation is the exception, and it costs the most here because polyroute runs the component inside V8 instead of a runtime built for fast instantiation. The safety property that mattered most, that a panic can't poison later requests, still holds, because a trapped instance is thrown away.

## Consequences

- Global state persists between requests to a route. Routes must not keep one request's data in globals for the next.
- An instance's memory stays allocated for the life of the process, once per route.
- A guest that leaks memory or handles across requests now grows instead of being reset.
- `"per-request"` remains available for routes that need strict isolation.

## Update, 2026-11-16: Go instances are replaced after 1,000 requests

A soak test found the leak the consequences warned about, in Go. `cabi_realloc` in `go.bytecodealliance.org/pkg` v0.4.1 pins every buffer the host allocates in the guest, such as the strings and lists that `wasi:http` imports return. The generated import bindings never unpin them. Under load, one reused Go instance's linear memory grew from 58 MB to 314 MB in 45 seconds, and its throughput halved as each new pin got slower. Rust's memory stayed flat, and Python's grew far more slowly without slowing down.

A language can now set how many requests one instance serves before the runtime replaces it, and Go sets 1,000. Each Go instance then stays near 11 MB, and throughput holds steady. A 10,000-request limit measured within 2% of it, with more memory per instance. The replacement starts when the next request arrives, so that request waits for a new instance, as the first request does.

The runtime now also checks, right before calling `handle`, that the instance it acquired hasn't been retired. Requests queued on one instance used to pass that check before any of them ran, so when one trapped, the requests behind it called the stopped instance and failed too.

## Update, 2026-11-16: jco's handle tables no longer grow with every request

jco adds the rep of every resource it hands the guest to a Set on that resource's handle table, and nothing reads or empties the Set. With a fresh instance per request, that didn't matter. A reused instance's Sets grow by 9 to 11 entries a request. On the example's Rust route the heap grew by about 90 MB over 400,000 requests, and the busiest Set would reach V8's limit of 2^24 entries after about 8.4 million, past which `Set.add` throws. The transpiled bindings now skip the `add` when the Sets have no other use. The heap then stays flat, and each request is about 15% cheaper in-process.

## Update, 2026-11-16: routes that send requests get a pool

A route that sends outbound HTTP requests is transpiled with JSPI, and its `handle` can suspend while it waits for a response ([0003](0003-outbound-http-with-jspi.md)). Requests to it can then overlap, so "nothing awaits between taking the instance and returning from `handle`" no longer holds for it. The runtime now keeps a pool of reused instances per route. A request takes an idle instance or starts a new one, up to 32 for a route that suspends, and releases it when it's done. Each instance still serves one request at a time. A route that never suspends is limited to one instance and behaves as described above.
