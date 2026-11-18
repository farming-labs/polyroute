# 0013: Test passing the Go cleanup handle as an argument

Status: isolated generator candidate built and resource probes passed, 2026-11-18. HTTP checks retain only the known oversized-response failures in both variants; timing remains pending. No production SDK or compiler change.

## Problem and scope

The standalone profile retains increasing Go guest-call cost as an instance approaches its 1,000-request replacement. Earlier Go guest profiling in ADR 0008 points to `runtime.AddCleanup`. The generated bindings capture a mutable `*witRuntime.Handle` in a new cleanup closure and pass an unused integer argument. The installed Go 1.27.4 runtime forces the closure to escape, inspects captured pointers, and allocates argument storage during registration.

Test passing the same mutable handle as the cleanup argument to a callback that captures nothing. Keep `TakeOrNil`, explicit disposal, ownership transfer, borrowed wrappers, forgotten-resource cleanup, and the 1,000-request limit unchanged. Do not replace the handle with its integer value: the cleanup must observe a handle already consumed or transferred by the caller.

This is separate from cleanup cancellation and the pin-lifetime hook. Neither is included, and the response-writer bug remains. [Go issue 75188](https://github.com/golang/go/issues/75188) supplies context for cleanup overhead; it does not prove a gain for this change.

## Verification plan

Regenerate the published SDK exactly before generating the candidate. Inspect the generated differences and test real resource ownership, including forced collection, forgotten resources, drop, transfer, restore, borrowed handles, copied wrappers, and trap recovery. Run the existing production HTTP checks with jco and Wasmtime, retaining the known oversized-response failures.

Only after that audit, measure the unchanged short-response slug workload through the original standalone host and matched TypeScript, at one and ten connections. Retain five alternating rounds, one-second warmups, three-second samples, each arm's A/A control, twenty cold samples, p95, environment, hashes, sizes, and all failures. A short diagnostic can reject the candidate but cannot establish acceptance. A slug improvement cannot establish compatibility for the known failing large-response case or satisfy the full goal.

## Source and resource evidence

The `polyroute-go-cleanup-callback-20261118` experiment uses the pinned wit-bindgen 0.62.0 source and compatibility corrections recorded in ADR 0008. The generator changes two lines: the cleanup callback receives `*witRuntime.Handle`, and the registration passes that handle instead of zero. Generated files are not hand-edited, and the shared module cache is untouched.

`python3 regenerate.py baseline` reproduces all 65 WASIp2 files byte-for-byte. `python3 regenerate.py candidate` changes eleven files covering 25 resource types. A source audit confirms that every generated difference is exactly the callback parameter and argument change, with no other generated churn.

`node build-resources.mjs` built both real components. `node check-resources.mjs` passed all twenty scenarios. Both variants still run the original cleanup counts: 256 after ordinary disposal or forgotten ownership, and 512 after transfer and disposal of both wrappers. Borrowed wrappers preserve their owners. Forgotten handles are unavailable in the host, and a trapped request is followed by a successful fresh-instance request. The candidate does not disable or cancel cleanup registrations to obtain a faster result.

Source patches, generator and component hashes, generated SDKs, commands, and resource results remain in the isolated directory. No upstream publication or integration has occurred.

`node build-http.mjs` built jco and Wasmtime bundles for both SDK variants. `node check-http.mjs` passed 574 checks and failed the same two oversized-response assertions: original and candidate native writes of a 1 MiB body plus prefix/suffix exceed the host write budget. Both jco variants passed all 144 checks; both native variants passed 143. Outbound requests, denial, redirects, decoding, concurrent calls, retained data and forced collection retain their assertions. The command exits nonzero, and the two failures remain recorded. This is not complete HTTP acceptance and does not justify production integration.

Generator quality checks used its existing workspace and locked dependencies: `cargo fmt --manifest-path generator/Cargo.toml --all --check` and `cargo clippy --manifest-path generator/Cargo.toml --locked --no-default-features --features go --bin wit-bindgen -- -D warnings` passed. `cargo test --manifest-path generator/Cargo.toml -p wit-bindgen-go --locked` compiled and exited successfully but contains zero unit or documentation tests; it is not test coverage. The real component probes above supply the ownership evidence. The full upstream generator test matrix was not run.

`node build-slug.mjs` built both variants from the identical example source and validated the exact response through the current addon. The separate HTTP timing harness loads these artifacts through the unchanged standalone host; no scheduling, compiler, route, or reuse-limit change is included.

## Short diagnostic

`node measure.mjs --mode check --comparison ab` validates the real HTTP response for the original, candidate, and TypeScript. The short diagnostic then completed eighteen measured samples at one and ten connections, with zero response errors and no discarded samples. It uses three alternating rounds, 500 ms warmups, and one-second measurements. Recorded source and artifact hashes remained unchanged.

| Connections | Original / candidate / TypeScript req/s | Candidate / original |
| ----------- | --------------------------------------: | -------------------: |
| 1           |                   6,543 / 7,016 / 9,319 |               1.072× |
| 10          |                10,236 / 11,705 / 18,069 |               1.143× |

This is a promising direction check, not an established gain: the short run has no A/A or cold acceptance evidence. The candidate still trails TypeScript. The full twelve-report comparison with every arm’s A/A controls and twenty cold samples is running; no adoption decision follows from these diagnostic medians.
