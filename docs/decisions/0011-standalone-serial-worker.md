# 0011: Test one persistent worker for synchronous guest calls

Status: isolated candidate built and correctness probes passed, 2026-11-18. The short timing diagnostic is mixed; the candidate is not adopted. No production runtime change.

## Problem

The standalone host in ADR 0010 serializes non-outbound requests with a mutex inside Tokio's `block_in_place`. This is necessary to avoid entering Wasmtime's synchronous imports from an asynchronous task, but it also couples every guest call to the HTTP executor's worker handoff. The checked Tokio 1.54.1 implementation moves the scheduler core and calls `spawn_blocking` to continue driving it. Concurrent requests can occupy blocking threads while waiting for the same guest mutex.

That is a scheduling-cost hypothesis, not a measured attribution. The first standalone comparison must finish, including both A/A controls, before timing another candidate. Its binary, sources, components, logs, and reports remain unchanged.

## Experiment

For a non-outbound route, create one owned guest thread at startup. Send owned request data over a bounded channel and return the owned result over a per-request channel. Keep one `Worker` on that thread, with the same Wasmtime engine, component, private Python resource implementation, reuse and replacement policy, trap recovery, and response validation. Enter the existing Tokio runtime on that thread so synchronous WASI calls can drive their futures without moving the HTTP executor's worker for every request.

Keep outbound dispatch and its 32-request bound unchanged. Do not change guest code, SDK versions, algorithms, input sizes, HTTP behavior, or compiler options. This experiment tests the host's scheduling mechanism only.

The queue has a finite capacity. Closing the server closes the queue, releases queued request data, and joins the owned thread. An unavailable worker returns an explicit error; it must not fall back to the old path or silently restart a failed worker. Drop a queued request whose response receiver was cancelled before execution. Guest traps still retire only the instance through the existing worker implementation.

## Acceptance

Run the same real HTTP, policy, network, shutdown, reuse, retained-data, and trap checks as ADR 0010. Add a sustained concurrent counter check to establish that requests still execute serially without losing or duplicating state changes. Verify shutdown with queued work and preserve any failure. No claim of interrupting arbitrary guest CPU execution follows from cancelling outbound requests or closing a queue.

If those checks pass, compare the original and candidate host on identical components, retaining matched TypeScript, alternating rounds, both A/A controls at one and ten connections, cold samples, p95, artifact sizes, and all failures. A change within control variation is inconclusive. Only a demonstrated gain justifies adopting this dispatcher. The full cross-platform and deployed serverless performance goal remains required before merging.

## Correctness result

The candidate in `polyroute-standalone-worker-20261118` changes only `src/main.rs`. Its host core, outbound client, Python interface, Cargo dependencies, and guest components match the original experiment byte-for-byte. The original source and measured binary remain intact.

The worker owns a 32-entry channel and a cancellation token. It closes the receiver on shutdown, returns explicit cancellation errors to waiting callers, and joins the thread. Request senders are released before awaiting the reply; an exit guard cancels pending calls if the worker thread unwinds. Outbound dispatch is unchanged.

An initial test stalled while retaining queue reservations and a sender, then awaiting disposal of messages submitted through those reservations after the receiver closed. The test was corrected to release the owners of that queued data before asserting disposal. Its logs and thread sample remain preserved. A separate cancellation regression then demonstrated that the first candidate left a caller waiting when shutdown occurred while a job still owned the reply. `cargo test --release --locked shutdown_settles_callers -- --nocapture` failed that assertion before the fix. The revised call path observes worker cancellation while waiting both to enqueue and to receive its response; the unchanged assertion passes afterward.

Local verification:

- `cargo test --release --locked`: seven tests passed, including real guest state across 200 concurrent calls, cancellation before execution, trap recovery, shutdown with live senders and reserved capacity, and the cancellation regression.
- `cargo fmt --all --check`, `rustfmt --edition 2024 --check src/core.rs`, and `cargo clippy --release --all-targets --locked -- -D warnings`: passed.
- `cargo build --release --locked`: passed.
- `node check-http.mjs`: the original 14 groups passed.
- `node check-network.mjs`: the original eight groups passed.
- `node check-dispatch.mjs`: three groups passed. Rust and Go each returned every count from 1 to 1,000 exactly once under concurrent HTTP requests; Go then restarted at one. SIGTERM during concurrent requests exited and settled every caller.
- `node measure.mjs --mode check --comparison ab`: all six workloads returned correct responses for the original host, candidate, and TypeScript, with the exact relay request count.

The short diagnostic uses three alternating rounds, 500 ms warmups, and one-second samples. It is a direction check, not acceptance evidence, and remains separate from the full five-round measurements and A/A controls. No throughput improvement, production integration, or provider result is claimed yet.

## Diagnostic result and decision

Both short runs completed on the same local Apple M1 machine, with Node 24.21.0 and the unchanged guest components. The 108 measured rounds and their warmups reported zero errors, with no discarded samples. The relay counts exactly matched the completed requests, and every recorded source and artifact hash was unchanged after measurement.

| Workload                | Original / candidate / TypeScript req/s, 1 connection | Original / candidate / TypeScript req/s, 10 connections |
| ----------------------- | ----------------------------------------------------: | ------------------------------------------------------: |
| Rust, little work       |                                 9,845 / 9,561 / 8,899 |                                15,680 / 17,222 / 17,960 |
| Rust, primes to 10,000  |                                 4,608 / 4,526 / 2,825 |                                   6,433 / 6,618 / 4,356 |
| Rust, primes to 100,000 |                                       332 / 334 / 234 |                                         348 / 347 / 245 |
| Go                      |                                 6,312 / 5,861 / 8,804 |                                10,238 / 11,446 / 17,238 |
| Python                  |                                 6,650 / 6,749 / 7,424 |                                13,222 / 13,714 / 14,213 |
| Rust relay              |                                 5,393 / 5,459 / 4,876 |                                14,013 / 14,548 / 12,714 |

These medians are diagnostic observations, not demonstrated improvements or regressions: this short series has no accompanying A/A controls or cold comparison. It is enough to decline adoption and prioritize profiling. The candidate remains below matched TypeScript for Go and Python at both connection counts, and the single-connection observations do not support a general scheduling win. A full control series would still be required before reconsidering it. Raw samples, p95 values, commands, logs, binaries, and provenance remain in the isolated experiment directory.
