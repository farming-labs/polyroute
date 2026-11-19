# 0007: Investigate batched Python HTTP transfers in the native runtime

Status: implemented in the experimental runtime, 2026-11-18. Local compatibility, packed checks, and the final artifact comparison pass. Cross-platform CI remains pending; the broader performance merge gate remains unmet.

## Problem

The matched Python statistics route still loses to TypeScript. Its native guest profile points to request bridging and resource management. A separate `cProfile` build of the same handler recorded 19 component imports and nine weak-reference finalizers per request. Over 1,000 verified requests, the instrumented request reader accumulated 90 ms, the response sender 74 ms, and the user handler 52 ms. These instrumented timings identify work to investigate; they are not request-latency or acceptance measurements.

An isolated, uninstrumented response-adapter experiment skipped the default status setter only for a built-in integer `200`, skipped mapping checks for absent headers, and reused a compact JSON encoder. Twenty real guest cases preserved bytes, headers, invalid statuses, and recovery. Five alternating production rounds with one-second warmups, three-second samples, matched TypeScript, and both A/A controls produced:

| Connections | Original / candidate (req/s) | Candidate / original | Original / candidate p95 (ms) | Matched TypeScript (req/s) |
| ----------- | ---------------------------: | -------------------: | ----------------------------: | -------------------------: |
| 1           |                4,402 / 4,563 |               1.037× |                 0.233 / 0.227 |                      8,486 |
| 10          |                7,368 / 7,541 |               1.023× |                 2.586 / 2.536 |                     17,301 |

The two one-connection A/A median ratios were 1.009× and 1.007×, with paired ratios reaching 1.083×. At ten connections, A/A median ratios were 0.972× and 0.985×, with paired ratios spanning 0.959–1.059×. The apparent improvement is too unstable to attribute. All responses were correct and no samples were discarded. The experiment ran on Apple M1, macOS 25.2.0, Node 24.21.0, componentize-py 0.25.1, and Wasmtime 50.0.2. Keep these changes out of the production adapter.

## Decision under evaluation

Test a private native-host interface that transfers an already-buffered Python request in one call and its completed response in one call. This targets repeated component calls and temporary resource wrappers, while leaving the route's `Request`, `Response`, and handler API unchanged.

- Select the interface only when building Python with `experimental.runtime: "wasmtime"`. Add no public flag. The default jco build and development continue using standard `wasi:http` imports and remain portable to a compatible WASI host.
- Keep the standard incoming-handler export. Pass its typed request and response-outparam resources to the private interface; do not expose numeric handles or an ambient "last request" to guest code.
- Reuse the existing Python request/response classes and method dispatch. Supply native transfer helpers at the internal adapter boundary instead of duplicating the public API.
- Implement the host functions using Wasmtime's resource table and existing HTTP validation. The bridge must not introduce a permissive status, header, content-length, or body path.
- Keep outbound requests on the existing allowlisted host. The new interface grants access only to the current incoming request and its response. It grants no filesystem, environment, arguments, sockets, or DNS access.
- Keep generated code generated. Do not edit componentize-py bindings or its runtime, and do not patch upstream resource finalizers.

The native addon and Python component share this private interface. The emitted `.cwasm` already requires the matching native host; this does not add a portability claim for that artifact. Missing or mismatched imports must fail, with no fallback to an unverified host path.

The local implementation calls the existing WASI resource traits inside each host function. Reads consume the incoming body and release its stream and future trailers. Sends create fields and an outgoing response, validate status and content length, set the original response callback, write through the existing output stream, and finish the body. Any failure traps and retires the instance, which drops its entire resource table; the host does not return a partial success. The guest retains ownership of its incoming-request resource and transfers ownership of its response-outparam.

Python build directories and transpilation cache keys include the selected runtime. The private import is accepted only during native transpilation, including on cache hits. A default build cannot reuse native bindings, and development selects the portable world even when the native build runtime is configured.

## Ownership and compatibility

- A request read must consume its body once, produce the same method, URL, Latin-1 headers, and bytes as the current adapter, and release every temporary resource on success and error.
- A response send must consume exactly its supplied response-outparam and follow the existing callback and body-collection lifecycle. A second send, stale handle, or wrong resource type must fail.
- Preserve duplicate cookies, header normalization and limits, Unicode JSON, arbitrary bytes, empty bodies, multi-chunk bodies, custom methods and statuses, HEAD behavior, and method-not-allowed responses.
- Preserve rejection of floats, strings, negative and overflowing statuses. Preserve content-length and malformed-header failures rather than turning them into successful responses.
- A trap retires the instance. The next request must use valid new state. Reuse, per-request mode, queued calls, and concurrent outbound instances must not share request or response data.
- Rust and Go components continue through their existing WASI path. They must not pay for copying a Python request snapshot.

## Verification plan

1. Keep the current implementation as the oracle. Run the response-contract fixture against both production runtimes before changing the bridge; it covers JSON bytes, reusable encoding state, headers, status validation, and recovery.
2. Prototype the private transfer interface and compare real guest responses and errors against the existing adapter. Include request metadata, binary and multi-chunk bodies, repeated headers, invalid lengths, malformed values, stale resources, double consumption, and a send followed by a trap.
3. Prove disposal using resource-table and repeated-request checks. Exercise both reuse modes and overlapping outbound requests without sharing request state.
4. Run full production and packed conformance, Node 22/24, and Linux/macOS/Windows. The default jco output must not import the private native interface.
5. Measure identical production workloads with five alternating A/B rounds and both A/A controls at one and ten connections, plus twenty cold samples. Retain raw samples, median/p95, artifact sizes, and losses. A new host path is accepted only after a gain outside control variation and complete compatibility evidence.

This experiment does not satisfy the overall TypeScript or serverless goal by itself. Provider cold-start measurements, the other languages, and the original merge gate remain required.

## Prototype measurement

The isolated transfer prototype used identical server code and the same native addon in both arms; only the Python adapter and WIT world changed. Its real guest responses matched the existing adapter across 97 cases in each instance mode. These included invalid statuses, malformed and forbidden headers, content-length failures, cookies, retained request data, custom methods, and binary bodies up to 1 MiB.

Five alternating production HTTP rounds per arm used a one-second warmup and three-second sample, with matched TypeScript and both A/A controls. The machine was Apple M1, macOS 25.2.0, Node 24.21.0, Wasmtime 50.0.2, and componentize-py 0.25.1. All responses were correct, no errors were recorded, and no samples were discarded.

| Connections | Original / transfer prototype (req/s) |  Ratio | Original / prototype p95 (ms) | Matched TypeScript (req/s) |
| ----------- | ------------------------------------: | -----: | ----------------------------: | -------------------------: |
| 1           |                         4,471 / 5,475 | 1.225× |                 0.231 / 0.203 |                      8,488 |
| 10          |                        7,429 / 10,492 | 1.412× |                 2.577 / 1.558 |                     17,437 |

At one connection, A/A median ratios were 0.984× and 1.005×, and paired A/A ratios spanned 0.978–1.075×. At ten connections, A/A median ratios were 0.976× and 0.994×, and paired ratios spanned 0.965–1.001×. The throughput effect exceeds these controls. Python still loses to TypeScript in both cases.

Twenty cold samples per arm measured original/prototype medians of 60.405 / 60.252 ms, with p95 of 62.142 / 62.427 ms. The median difference was −0.153 ms; the A/A median differences were −0.163 and −0.494 ms. This does not establish a cold-start improvement. Matched TypeScript's median was 51.452 ms. These are local process cold starts, not provider cold starts.

These measurements justify checking the integrated implementation. They are not measurements of the final packaged change: the prototype used a copied adapter and the same new addon in both arms. Keep the final artifact comparison separate.

## Integrated production comparison

A separate run compared the complete previous compiler-free deployment with the integrated production build. The previous runtime code is unchanged between `d868f63` and the documentation-only base `3c923c4`. Both arms used their own emitted addon and `.cwasm` files. Other components were rebuilt too, so this full-deployment check complements the isolated experiment above; it does not replace it or isolate artifact-size changes. The server code differed only in component filenames.

The environment, matched statistics workload, five alternating rounds, one-second warmup, three-second samples, both A/A controls, and twenty cold samples followed the same protocol. All response checks passed, no errors were recorded, and no samples were discarded.

| Connections | Previous / integrated Python (req/s) |  Ratio | Previous / integrated p95 (ms) | Matched TypeScript (req/s) |
| ----------- | -----------------------------------: | -----: | -----------------------------: | -------------------------: |
| 1           |                        4,386 / 5,761 | 1.314× |                  0.257 / 0.189 |                      8,621 |
| 10          |                       7,395 / 10,585 | 1.432× |                  2.589 / 1.553 |                     17,515 |

At one connection, A/A median ratios were 1.000× and 1.000×, with paired ratios spanning 0.997–1.096×. At ten connections, A/A median ratios were 0.983× and 1.005×, with paired ratios spanning 0.971–1.026×. The throughput gain exceeds these controls. Integrated Python remains 33.2% and 39.6% below matched TypeScript, respectively.

Previous/integrated cold medians were 59.330 / 58.975 ms, with p95 of 60.888 / 60.537 ms. The −0.356 ms median difference is within the A/A differences of −0.731 and +0.094 ms. No cold-start gain is established. Matched TypeScript's median was 50.783 ms.

The native addon grew from 5,368,128 to 5,401,296 bytes. The complete rebuilt deployment was 52,683,004 bytes versus 53,778,148 previously; do not attribute that whole difference to the transfer change because the other components were rebuilt. Both remain below the RFC size budget.

For each connection count, preserve both complete output directories and run:

```sh
node scripts/bench.mjs --no-build --matched --json --route Python --route 'TypeScript (stats)' --rounds 5 --duration 3 --warmup 1 --connections 1 --baseline <previous/server.js> --server <integrated/server.js>
node scripts/bench.mjs --no-build --matched --cold --json --route Python --route 'TypeScript (stats)' --rounds 20 --baseline <previous/server.js> --server <integrated/server.js>
```

Repeat warm measurements at ten connections. Repeat both protocols with each output directory on both sides for A/A controls. Keep every raw JSON sample and record the artifact hashes; do not combine this run with the isolated prototype or CI results.

## Local integration evidence

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm fmt:check` passed on Node 24.21.0.
- `cargo fmt --all --check`, both `cargo clippy --all-targets --locked --no-default-features -- -D warnings` and the `--features compiler` variant passed. `cargo test --locked` passed five tests with each feature set. The transfer tests use real WASI resources and verify repeated consumption, duplicate cookies, multi-chunk bodies, stale resources, and an empty resource table after completed requests and responses.
- `pnpm test` passed 12 script tests and 266 route tests, with three skipped. The first broad run exposed a test setup mistake: the new cache test performed cold compilation inside its timed assertion. Compilation now runs in setup, following the existing build tests; no timeout was changed.
- On Node 22.13.0, the response and outbound suites passed 132 tests with 22 JSPI-dependent cases skipped. The cache test initially hit that same setup timeout and then passed after the correction. Skipped jco outbound cases are not counted as passes; native outbound cases ran.
- `pnpm smoke`, `pnpm smoke:packed`, `pnpm smoke --runtime wasmtime`, and `pnpm smoke:packed --runtime wasmtime` each passed all 15 HTTP checks. These include all languages and the relay route.
- Loading the new Python component through the previous native addon failed because the private interface was missing. It did not fall back to another runtime.

The checked-in tests also exercise native and portable builds in the same cache, default-build rejection after a native cache entry exists, development with the native build option, invalid statuses and headers, response recovery, retained request data, HEAD, and both instance modes. CI on the changed implementation, provider cold starts, and the full TypeScript performance goal remain unverified.

## Alternatives

- The smaller response-setup changes above are insufficient evidence of a speed improvement.
- Lazy URL parsing does not address the main profile cost and must not shorten the lifetime of request data retained by user code.
- Replacing generated resource finalizers without fixing their generator would be an unsupported dependency patch.
- Switching every Python component to a private interface would break default WASI portability. Restrict the experiment to the already opt-in native backend.
