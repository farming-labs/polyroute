# 0004: Run native outbound routes off the JavaScript thread

Status: proposed, 2026-11-18. Implementation and verification are pending.

## Problem

The native prototype rejects every route that imports `wasi:http/outgoing-handler`. Its synchronous Node-API call blocks the JavaScript thread. Waiting for an upstream served by that same Node process would deadlock. This prevents the complete example and packed smoke from passing with Wasmtime.

The host already implements outbound policy, redirects, decompression, timeout mapping, and cancellation for jco. A second networking implementation would have to reproduce that behavior and its failure cases. Native HTTP support must not widen the guest's capabilities or require JSPI.

## Proposed decision

- Keep one synchronous Node-API call for routes without outbound imports. Their request path and instance semantics stay as they are.
- For an outbound route, return a Promise and run the synchronous guest on Tokio's blocking executor. Do not use Node's libuv worker pool: blocking all of its workers on requests whose DNS resolution needs that same pool can deadlock.
- Bound in-flight native calls to 32 per route, with waiting calls queued before they occupy a blocking worker. Keep one owner per instance. Reuse idle instances, replace Go instances at the existing request limit, drop trapped instances, and retain per-request isolation when selected.
- Implement Wasmtime's `WasiHttpHooks::send_request` by buffering the guest's request and invoking the existing JavaScript host through a Node-API thread-safe function. The callback uses `createOutboundPolicy` and `sendOutbound`; it does not implement another allowlist or HTTP client. Node-API calls cross threads only with owned data, as required by [napi-rs](https://napi.rs/docs/concepts/threadsafe-function).
- Give each incoming call its own callback and abort controller. Clear the instance's callback when the call finishes and abort its outstanding upstream requests on both success and failure. An idle instance must not retain a request's callback, output buffers, or controller. The native callback is absent by default and denies requests when absent.
- Preserve WASI error codes across the bridge. Invalid schemes, denied hosts, failed connections, timeouts, and cancellation must reach the guest as errors it can handle. A missing addon, rejected import, or failed native start must never fall back to jco.
- Pass the existing `outbound` option only to route modules whose component actually imports outbound HTTP. Enabling outbound for another route must not move a synchronous route onto a worker.

## Alternatives

Calling a Rust HTTP client would avoid a JavaScript callback but duplicate policy and response semantics. It can be reconsidered only with equivalent conformance coverage and a measured reason. Running the guest on the JavaScript thread cannot support self-requests. A worker per request would pay process or JavaScript worker startup costs and lose warm instance reuse.

## Consequences

Outbound calls gain a thread handoff and additional request/response copies. This is a correctness and capability change, not a performance claim. The matched benchmark must measure its cost against both jco and TypeScript. Native support should work on Node 22 as well as Node 24 because it does not depend on V8 stack suspension.

The full example must remain intact in verification. Dropping its relay route, excluding a language, or treating local process startup as deployed cold-start evidence does not meet the native runtime's acceptance criteria. The existing private addon and host-target restriction remain until packaging work addresses them separately.

## Verification plan

1. Run the existing Rust, Go, and Python outbound integration cases against both runtimes: GET, POST, denied hosts, concurrent self-requests, Python fan-out, and timers. Native cases run on Node 22 and 24.
2. Exercise shared host conformance through the native bridge: explicit ports and wildcards, redirects to denied hosts, duplicate cookies, encoded responses, connection failures, and request-option timeouts.
3. Verify that returning or trapping aborts unfinished upstream work and releases callback references. Check reuse, per-request isolation, request-limit replacement, and recovery after traps or failed starts.
4. Run all native tests in the owned child process and wait for exit before artifact cleanup on Windows. Run Rust formatting, clippy, tests, package build/typecheck, and workspace/packed smoke with both runtimes.
5. Measure paired A/B and A/A production builds at 1 and 10 connections, with the same requests and response checks. Record raw rounds, median/p95, artifact size, environment, and losses. Remeasure cold starts after correcting the shutdown timing bug.

No implementation is accepted by this document alone. Record the outcome and actual evidence here after verification.
