# 0023: Hold Vercel's pings while a synchronous guest call runs

Status: implemented in the private probe, 2026-11-21. Measured on Vercel with CI-built hosts. No public option or package changes.

## Problem

Under concurrent CPU-heavy load, the Vercel executable host served 0.18 to 0.28 times its TypeScript twin's rate. Counting primes below 1,000,000 takes about 205 ms of guest time. One connection at a time, Rust served 4.2 req/s against TypeScript's 2.6. At 10 and 50 connections from inside `iad1` it served 8.0 and 32.4 req/s against 29.1 and 158.7, with a p50 of 1.3 and 1.1 s, while the same component in Node through `createWasmtimeHandler` kept a single call's latency. [The languages record](../benchmarks/2026-11-21-vercel-languages.md#requests-per-second-cpu-heavy-route) has every number.

## Root cause

Requests waited behind a guest call on an instance that looked idle.

- The host runs synchronous guests one at a time behind a mutex. It ran each call inside `tokio::task::block_in_place` on a multi-threaded runtime with one worker. `block_in_place` hands that worker's scheduler to a new thread, so the runtime kept accepting connections during the call.
- `vercel_runtime` 2.4.1 answers `/_vercel/ping` on that same runtime, before the request reaches the route. Locally, the old host answered 2,836 pings during one 257 ms guest call, the slowest in 1.3 ms.
- Vercel's Fluid compute kept sending concurrent requests to an instance that was answering, and they queued on the mutex. In the same eight previews, eight 5-second runs at 50 connections started 111 instances of the old host and 321 with pings held.

## Decision

Synchronous guest calls run on one long-lived thread per route, and the request's task blocks the serving runtime's only worker until the call returns. While a guest call runs, nothing else on that runtime makes progress, pings included, as in a Node process whose event loop is running a request.

- **One persistent thread.** Calls reuse its Wasmtime state and stack, and no request pays to start a thread.
- **Its own Tokio handle.** Wasmtime's synchronous WASI imports drive their futures on the current Tokio handle. The guest thread enters a one-worker runtime of its own, which drives their timers and I/O. Without a handle, `wasmtime-wasi` falls back to a global runtime with a worker per CPU and yields before every call.
- **Preparation runs there too.** The instance the first request uses is created on the guest thread before readiness ([ADR 0021](0021-prepare-vercel-routes-before-readiness.md)).
- **Routes that send requests are unchanged.** They already run concurrent guests on blocking threads, up to 32 at a time, and keep answering pings.
- **The Lambda adapter is unchanged.** Lambda sends one request at a time to an instance.

`check-vercel-output.mjs` now starts the CI-built primes function, sends one 2,000,000-limit request and pings it until that request finishes. It requires the slowest ping to take at least half the call.

## Alternatives and consequences

- **`block_in_place`**, the old behavior, queues concurrent requests behind the guest.
- **A scoped thread per call, or a persistent thread without a Tokio handle,** spread the load as well. Both added 0.2 to 0.6 ms of guest time to first requests on pre-started instances (sets C and D in the record), from `wasmtime-wasi`'s fallback runtime. With the handle, the difference from the old host was −0.06, −0.04 and +0.24 ms (Rust, Go, Python; set E).
- **Changing `vercel_runtime`** to report busy instances would fork Vercel's bridge.
- **Hosting the component in Node** spreads load the same way but loses every first-request comparison by 50 to 290 ms.

An instance with a synchronous route serves one request at a time, as before; Vercel now knows it. A guest call holds pings for its whole duration. Calls of up to about 2 s answered every request in these runs; whether Vercel replaces an instance whose pings wait longer isn't known.

## Verification

- `check-vercel-output.mjs`'s new ping check fails against `main`'s host and passes against this one, both built for macOS and run with CI's macOS components: `main`'s answered 2,836 pings during a 257 ms guest call, the slowest in 1.3 ms, and this host's one ping waited 198 ms of a 198 ms call. On Linux in CI, a ping waited 285 ms of a 286 ms call.
- Rust formatting and Clippy with `-D warnings` pass on macOS, and CI's Amazon Linux build runs formatting, Clippy and the Rust tests.
- On Vercel (set E in [the record](../benchmarks/2026-11-21-vercel-languages.md#with-pings-held-during-guest-calls)), eight previews ran this host beside `main`'s. Under CPU-heavy load it served 1.33× and 1.41× TypeScript's rate at 10 and 50 connections, winning all 16 pairs, where `main`'s host served 0.24× and 0.18×. With 1.94 s calls it served 1.50× at 10 connections. First requests and light routes measured the same as `main`'s host. None of the 576 load runs or 96 first requests returned an error.

Not verified: Lambda, arm64, and guest calls longer than about 2 s.
