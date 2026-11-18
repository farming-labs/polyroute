# 0010: Test a standalone native host with pooled outbound HTTP

Status: isolated prototype built and compatibility probes passed, 2026-11-18. Matched local measurements are complete; the full throughput gate remains unmet. No public runtime option, deploy adapter, or provider deployment is implemented. A separate [serial-worker experiment](0011-standalone-serial-worker.md) is not adopted after a mixed short diagnostic.

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

## Matched local result

The standalone comparison completed nine reports: 360 warm samples and 720 cold samples across six workloads, A/B, and both A/A controls. Every measured response and the relay’s total upstream request count validated, with zero errors and zero discarded samples. All recorded probe source and binary hashes remained unchanged through the run. Environment: Apple M1, 8 logical CPUs, darwin 25.2.0, Node 24.21.0. Background operating-system activity remained present; the measurements and controls are retained together.

The host loads the identical production `.cwasm` components used by the addon. The TypeScript servers contain the matching route algorithms and the example’s existing Node request/response adapters. Both relay variants call the same separate upstream server. Native execution stays serialized without outbound imports; outbound execution retains its 32-request limit. This is a standalone deployment-shape experiment, not an isolated measurement of the cost of Node-API.

| Workload                          | Native / TypeScript req/s, 1 connection |  Ratio | Native / TypeScript req/s, 10 connections |  Ratio |
| --------------------------------- | --------------------------------------: | -----: | ----------------------------------------: | -----: |
| Rust (little work)                |                          10,056 / 9,010 | 1.116× |                           16,207 / 17,317 | 0.936× |
| Rust (primes to 10,000)           |                           4,638 / 2,751 | 1.686× |                             6,389 / 4,217 | 1.515× |
| Rust (primes to 100,000)          |                               334 / 233 | 1.432× |                                 345 / 242 | 1.425× |
| Go                                |                           6,296 / 8,985 | 0.701× |                           10,290 / 17,152 | 0.600× |
| Python                            |                           7,003 / 7,574 | 0.925× |                           13,450 / 14,166 | 0.949× |
| Rust relay (one outbound request) |                           5,576 / 5,013 | 1.112× |                           13,786 / 12,622 | 1.092× |

| Workload                          | Native / TypeScript p95 at 1 connection (ms) | Native / TypeScript p95 at 10 connections (ms) |
| --------------------------------- | -------------------------------------------: | ---------------------------------------------: |
| Rust (little work)                |                                0.110 / 0.119 |                                  0.759 / 0.637 |
| Rust (primes to 10,000)           |                                0.228 / 0.388 |                                  1.541 / 3.960 |
| Rust (primes to 100,000)          |                                3.025 / 4.378 |                                29.252 / 70.477 |
| Go                                |                                0.179 / 0.122 |                                  1.679 / 0.640 |
| Python                            |                                0.150 / 0.140 |                                  0.860 / 0.727 |
| Rust relay (one outbound request) |                                0.193 / 0.219 |                                  0.918 / 0.789 |

| Workload                          | Native cold median / p95 (ms) | TypeScript cold median / p95 (ms) | Median difference (ms) |
| --------------------------------- | ----------------------------: | --------------------------------: | ---------------------: |
| Rust (little work)                |                 5.421 / 6.319 |                   48.652 / 53.112 |                -43.230 |
| Rust (primes to 10,000)           |                 5.545 / 5.955 |                   48.556 / 52.339 |                -43.012 |
| Rust (primes to 100,000)          |                 8.223 / 8.565 |                   53.045 / 54.263 |                -44.822 |
| Go                                |                 8.107 / 8.319 |                   48.063 / 51.134 |                -39.955 |
| Python                            |               11.733 / 12.598 |                   49.309 / 51.019 |                -37.576 |
| Rust relay (one outbound request) |                 5.988 / 6.501 |                   55.245 / 58.858 |                -49.257 |

Both A/A controls are retained per workload. Across workloads, paired native control ratios span 0.965–1.047× at one connection and 0.966–1.041× at ten; TypeScript spans 0.937–1.046× and 0.960–1.027× respectively. Native cold A/A median differences range from −0.385 to +0.269 ms, and TypeScript’s from −0.509 to +1.028 ms. The cold-start gaps are substantially larger than this control variation.

The local cold-start improvement is clear, but throughput is incomplete: Go and Python remain below matched TypeScript at both connection counts, and light Rust falls below it at ten. The ten-connection relay has higher median throughput but worse p95 latency. Retain these losses rather than accepting only compute-heavy Rust or cold start. No Linux, Windows, provider, or production integration result is implied.

The warm A/B relay reports contain 209,398 upstream requests over 11 connections at one connection, and 527,740 over 83 connections at ten. These counts cover both arms plus the reporting request; they are not per-variant connection counts. The dedicated earlier 1,000-request test establishes single-connection reuse for the native client. Long gaps between benchmark rounds can expire idle connections.

The standalone binary is 8,404,320 bytes; SHA-256 `68853daf7f7343c6185622699185fd7d98f463e3a912968ba35b3a54b92ea54b`. Its size excludes the component, which is recorded separately for each route. The TypeScript artifact does not include the provider’s Node runtime. Neither a deployment size nor provider startup is inferred from these local files.

`python3 run.py` produced all nine reports; `python3 summarize.py` recalculated the summary, checked report completeness and exact relay counts, and confirmed zero errors/discards. `comparison.html` presents the measurements, p95, and controls without combining them with CI or earlier experiments. The subsequent [serial-worker experiment](0011-standalone-serial-worker.md) is not adopted after a mixed short diagnostic.

## Next diagnostic

Profile an isolated copy of the original host before choosing another optimization. Record time spent instantiating or reusing the store, constructing the request, executing the guest and its imports, collecting the response, and retiring the instance. Include the surrounding HTTP preparation, dispatch wait, and response conversion. Keep the original source, binary, and benchmark reports unchanged. Use the same components and validate every response.

Instrumentation adds overhead, so these measurements can locate a dominant phase but cannot establish an optimization gain. Keep initial requests and Go's periodic instance replacement identifiable in the raw records. Any resulting candidate still needs its own correctness checks and matched A/B and A/A comparison before adoption.

## Phase attribution

Two isolated instrumented copies completed the six workloads at one and ten connections. Each run validates 1,000 initial requests and 5,000 subsequent requests per workload/count, retaining every record: 72,000 correct responses and 144,000 paired HTTP/worker spans per copy. `node profile-http.mjs` accounts for every span and the exact relay count. `python3 summarize.py <experiment-directory>` validates phase sums, request identifiers, completeness, and all original and instrumented source/artifact hashes. No source or binary from the completed throughput comparison changed.

The first copy, `polyroute-standalone-profile-20261118`, records worker phases without changing the engine or guest. These are means over the prescribed 5,000 subsequent requests, in microseconds; initial records and p95 remain in the raw reports.

| Workload | Connections | Whole worker | Guest execution plus imports | Store creation/reuse plus retirement |
| -------- | ----------: | -----------: | ---------------------------: | -----------------------------------: |
| Go       |           1 |        76.84 |                        72.72 |                                 1.13 |
| Go       |          10 |        83.49 |                        78.51 |                                 1.23 |
| Python   |           1 |        41.92 |                        38.87 |                                 0.20 |
| Python   |          10 |        47.65 |                        43.37 |                                 0.23 |

Go still replaces its instance every 1,000 requests. All six creations and retirements in each 6,000-request run are identifiable. Their measured cost is included; the remaining overhead is not primarily the periodic replacement.

The second copy, `polyroute-standalone-import-profile-20261118`, additionally enables Wasmtime's `call-hook` feature and records nested transitions between Wasm and host execution during the guest call. These timings include instrumentation overhead and must not be compared as a before/after result with the first copy.

| Workload | Connections | Host interval mean (µs) | Wasm interval mean (µs) | Median host transitions per request |
| -------- | ----------: | ----------------------: | ----------------------: | ----------------------------------: |
| Go       |           1 |                    9.29 |                   65.33 |                                  29 |
| Go       |          10 |                    9.85 |                   68.26 |                                  29 |
| Python   |           1 |                    7.77 |                   35.12 |                                   4 |
| Python   |          10 |                    7.81 |                   33.67 |                                   4 |

These transitions include Wasmtime runtime calls, not only named WASI imports. Wasm time includes the language runtime, SDK, guest-side binding work, and route code. The counters do not identify which of those dominates. Host intervals include canonical lifting/lowering and any nested execution is charged to its active mode. Not every trivial runtime call participates in Wasmtime's hook.

The diagnostic supports investigating guest-side work next. It does not justify removing Go's resource-lifetime cap, dropping HTTP work, or attributing all Wasm time to the route algorithm. [ADR 0012](0012-python-response-encoder.md) tests one small repeated allocation in Python's response adapter. Go's remaining cost, production integration, and provider verification remain open.
