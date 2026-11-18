# 0010: Test a standalone native host with pooled outbound HTTP

Status: isolated prototype built and compatibility probes passed, 2026-11-18. Matched performance measurements are running. No public runtime option, deploy adapter, or provider deployment is implemented.

## Problem

The Node addon still pays Node startup plus native loading. Local matched measurements do not establish a cold-start win over TypeScript. The earlier `wasmtime serve` diagnostic started faster, but it used different host capabilities and concurrency settings. Its relay workload exhausted connections because each outbound request opened a new connection. That failed run is not acceptance evidence.

RFC 0001 lists standalone functions as the next option if the addon misses its performance gate. Test that option without changing the guest algorithms, Go SDK, production compiler, or provider configuration.

## Decisions

- Build a private local Rust HTTP host around the current Wasmtime 50.0.2 engine configuration, linker, typed WASI resources, instance reuse, Go's 1,000-request cap, trap retirement, captured output, and buffered body completion.
- Load the same trusted `.cwasm` artifacts as the current addon. Include the existing native Python transfer implementation unchanged. Do not enable a different allocator or recompile components with different engine settings merely to improve timings.
- Serialize non-outbound guest execution as the addon does. Bound outbound execution to 32 active requests, allowing waiting network calls without blocking the HTTP event loop. No unbounded worker or instance creation.
- Give outbound requests a shared pooled client. Disable automatic redirects, system proxy inheritance, retries, and cookie storage. Check the configured allowlist for every request, including requests a guest makes while following redirects. Keep certificate verification, decoded-body header handling, duplicate cookies, timeouts, and request-scoped cancellation in scope.
- No preopened directories, environment variables, arguments, guest sockets, or guest DNS. Deny outbound requests by default. The local listener binds loopback; starting it is not a deployment.
- Keep this implementation in an owned experiment directory until its correctness and performance justify a production integration. Prototype command arguments are not a proposed public API. Do not silently replace the addon or the default jco runtime.

## Alternatives

Keeping the addon preserves the current deployment shape, but adds a boundary and initialization work to Node. The unmodified Wasmtime CLI has already failed the sustained relay diagnostic and does not implement Polyroute's capability contract. Raising socket limits or omitting relay would not fix that mechanism.

## Consequences

A standalone host must reproduce the existing outbound policy rather than call its JavaScript implementation. That is a new authority boundary and requires differential conformance tests before any compatibility claim. A faster local process is not evidence for provider scheduling, artifact download, or platform packaging. The provider decision remains open; this prototype does not choose or deploy one.

## Verification plan

1. Validate the actual precompiled artifacts and the original/standalone responses, including the outbound relay and its upstream request count.
2. Test reuse, per-request isolation, Go replacement, retained data, traps and recovery, missing artifacts, stderr, denied capabilities, policy matching and redirects, decoded responses, cookies, timeout codes, concurrent upstream calls, and cancellation after success and failure. Check connection reuse against the real upstream server's connection counter.
3. Run the existing matched workloads with equal connection counts at one and ten, five alternating rounds, one-second warmups, three-second samples, both A/A controls, and twenty cold samples. Keep raw samples, p95, environment, sizes, all errors, and every failure. Do not run builds during timing or combine this with the isolated Go SDK patches.
4. Only after this local result, decide whether to integrate a reusable host core and a provider adapter. Production and packed verification, Linux/macOS acceptance, provider measurements, and the full TypeScript goal remain required before merging.

## Prototype and correctness evidence

The owned `polyroute-standalone-host-20261118` experiment contains a private Rust binary, locked dependencies, copied production guest components, matched TypeScript servers, fixture builds, source and artifact hashes, tests, and measurement scripts. It uses Wasmtime 50.0.2, Hyper, Tokio, and Reqwest 0.13.5. The existing private Python resource implementation is copied from the production addon. The Go SDK and guest algorithms are unchanged.

The synchronous guest calls remain serialized. Tokio's `block_in_place` allows Wasmtime's synchronous imports to drive their futures without attempting to start a runtime inside an asynchronous task. Outbound guests run on blocking workers after acquiring one of 32 permits. The listener, connection pool, and pending requests share explicit shutdown cancellation. Persistent signal receivers handle both SIGINT and SIGTERM; this initial probe targets Unix and has only been run on macOS arm64.

The initial HTTP run failed because synchronous guest calls entered Tokio incorrectly and the TLS client had no configured crypto provider. The next run exposed intermittent missed shutdown signals. A differential policy test also rejected the first parser because JavaScript treats U+FEFF as whitespace. Real network tests caught incorrect TLS-certificate, DNS, and connection-reset error mapping. The first two failed binaries and the failure logs remain preserved separately; they are not performance evidence. The corrected implementation passes the same checks.

Final local verification used Node 24.21.0 and the release host:

- `cargo fmt --all --check` and `rustfmt --edition 2024 --check src/core.rs src/outbound.rs`: passed.
- `cargo clippy --release --all-targets --locked -- -D warnings`: passed after fixing the reported style issue without suppressing it.
- `cargo test --release --locked`: five tests passed. These include the existing Python resource tests and a differential comparison against the actual JavaScript policy: 80 configurations, with 627 URL matching cases across the valid configurations.
- `cargo build --release --locked`: passed. The measured binary is copied only after this build and hashed before timing.
- `node check-http.mjs`: 14 groups passed. These cover reuse and per-request isolation, trap recovery and captured stderr, Go's 1,000-request replacement, body boundaries through 1,048,577 bytes for Python, retained request data, invalid response recovery, duplicate cookies, Latin-1 headers, all three outbound languages, denied hosts, concurrent requests, Python fan-out, decoding, redirects, timeouts, and cancellation after success and traps. A separate sustained check made 1,000 correct upstream calls over exactly one connection.
- `node check-network.mjs`: eight groups passed. Four compare actual refused connections, self-signed certificates, resets, and missing DNS names against the existing JavaScript host. Two exercise 20 immediate shutdowns each, and two prove shutdown cancels an active upstream request and exits.
- `node measure.mjs --mode check --comparison ab`: all six native/TypeScript workload pairs returned the expected response, including the relay's exact upstream request count. This single-sample check is not a performance result.
- `pnpm exec oxfmt <probe JavaScript files>` and `pnpm exec oxlint <probe JavaScript files>`: passed; the unused import reported on the first lint run was removed.

`python3 run.py` runs the twenty-sample cold comparisons followed by the five-round throughput comparisons at one and ten connections, with both A/A controls. It preserves raw reports, correctness failures, upstream request and connection counts, p95, environment, and artifact hashes. No local builds or other load tests run alongside these timings. Ordinary background operating-system activity remains present and the controls are required when interpreting the result.

These checks establish the tested local behavior only. They do not establish exhaustive URL or network-error equivalence, trusted remote TLS success, Windows support, deployed package behavior, or serverless performance. The existing Go SDK oversized-response failure from ADR 0009 remains; the standalone host does not relax the write budget or include the isolated SDK fix. Neither an upstream SDK publication nor a provider deployment has occurred.
