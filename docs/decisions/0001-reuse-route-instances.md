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
