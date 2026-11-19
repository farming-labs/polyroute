# 0016: Measure the combined Go cleanup changes

Status: isolated combined candidate passes local correctness checks and improves measured throughput, 2026-11-18; it still trails TypeScript and does not improve cold start. No production SDK change or upstream publication.

## Problem and scope

Cleanup cancellation and passing the mutable handle as a cleanup argument each improved Go throughput in separate comparisons. Their effects may overlap. Neither result establishes that the combination wins, and the original response writer still violates the WASI stream budget for large responses.

Measure a combined candidate against a baseline that includes only the already-verified response-writer fix from ADR 0009. Apply that identical writer fix to both arms before comparing cleanup behavior. This makes the full HTTP suite meaningful without including a known failing response writer in either arm. It is not a comparison against the unmodified production SDK, and percentages from earlier experiments must not be added to it.

## Decisions

- Start from the pinned generator and SDK provenance in ADRs 0008 and 0013. Reproduce the published SDK bindings exactly, then regenerate the candidate from source. Never hand-edit generated bindings or the shared Go module cache.
- Combine the existing `Cleanup.Stop` ownership/restore behavior with a callback that receives the same mutable `*witRuntime.Handle` as its argument. Preserve `KeepAlive`, borrowed ownership, forgotten-resource collection, trap retirement and the 1,000-request limit.
- Apply only the existing `responseOutparamWriter.Write` delegation to `outgoingBody.Write` to each regenerated SDK. Keep this source patch separate from generator changes. No pin-lifetime hook, runtime scheduling change, compiler setting change, or guest algorithm change is included.
- Use owned temporary directories and local Go module replacements. The maintenance path and upstream permission remain unresolved; a passing private experiment does not authorize silently patching user dependencies.

## Acceptance and verification

Audit all baseline generated files against the published SDK, then audit the combined generator patch and generated resource changes. Run the real resource ownership scenarios, full production HTTP checks through jco and Wasmtime, and the partial-write/error-count cases with both corrected response writers. Preserve initial failures and verify recovery after every trap/error.

Only after correctness passes, compare the unchanged slug route through the original standalone host and matched TypeScript. Use five alternating rounds, one-second warmups, three-second measurements at one and ten connections, each arm's A/A controls, twenty cold samples, medians/p95, sizes, hashes, environment and every response check. No builds run during timing. Do not integrate a gain within observed control variation, combine results from different runs, or claim provider performance from local process measurements.

Production integration, cross-platform and packed checks, the SDK maintenance decision, provider measurements and the full TypeScript goal remain separate gates.

## Local correctness evidence

The owned experiment directory is `/tmp/polyroute-go-combined-cleanup-20261118`. The baseline audit checks all 65 previously reproduced generated files against the published SDK and prior generation hashes. It does not rerun the baseline generator. `python3 regenerate.py candidate` regenerates 65 files with eleven changed files covering 25 resource types. Both SDKs receive the identical source-only writer patch; their corrected `adapter_p2.go` hashes match the verified ADR 0009 writer. Generated bindings are not hand-edited.

The combined generator passes `cargo fmt --manifest-path generator/Cargo.toml --all --check` and `cargo clippy --manifest-path generator/Cargo.toml --locked --no-default-features --features go --bin wit-bindgen -- -D warnings`. `node build-resources.mjs` and `node check-resources.mjs` pass all twenty real ownership scenarios. Candidate explicit disposal/transfer queues zero redundant callbacks, while both variants collect all 256 forgotten resources. Borrowing, restored ownership, trap retirement and subsequent requests retain their assertions.

`node check-http.mjs` passes 576 checks: 144 each for baseline/candidate through jco/Wasmtime. The unchanged checks cover exact bodies through a 1 MiB input plus echo metadata, outbound requests and policy denial, redirects, decompression, concurrent calls, and 128 retained-body/forced-collection requests per arm. `node build-write-counts.mjs` and `node check-write-counts.mjs` pass twelve native cases with successful next-request recovery in every case. Both corrected writers report 4,096 bytes before the deliberate partial-write error, preserve cookies and exact successful bodies, and reject unfinished or invalid-length responses without returning partial success. The old writer's before/after regression remains separately recorded in ADR 0009; this combined test expects corrected behavior in both arms.

## Preparation failure and limits

The first generator source copy exhausted local disk and was moved to `generator.incomplete` before retrying. The HTTP build later completed both baseline bundles and candidate jco, then failed with `ENOSPC` while writing candidate native code. The failed output and logs remain. After verified compression of completed, separate experiment artifacts, `node retry-http-candidate.mjs` built only that missing bundle into a new directory, retaining the failed directory and atomic cache temporary file. The HTTP report records the exact successful bundle paths. No assertion, timeout, compiler setting, or cache validity rule changed.

Compression manifests record original sizes, modes, timestamps and SHA-256 hashes, and restore scripts preserve the archived bytes. A redundant generator binary was hash-verified against its existing build output and hard-linked to recover space; neither path may be rebuilt in place while linked. Sources and benchmark reports remain intact. These storage operations occurred before any timing.

The correctness-only artifacts were subsequently compressed with the same size/hash verification and restore instructions before building the separate slug artifacts. The benchmark inputs remain uncompressed. No build, compression, or other load test ran during timing.

## Full combined comparison

`node build-slug.mjs` built both SDK variants from the unchanged example route and verified the exact response. `node measure.mjs --mode check --comparison ab` verified the baseline, combined candidate and matched TypeScript through real HTTP. Both native arms use the original standalone host, with SHA-256 `68853daf7f7343c6185622699185fd7d98f463e3a912968ba35b3a54b92ea54b`; the host, route algorithm, TypeScript bundle, compiler settings and 1,000-request limit are unchanged.

`python3 run-full.py` completed twelve reports with 90 warm samples and 180 cold samples, zero response errors and no discarded samples. `python3 summarize.py` verifies the run counts, alternating order, settings, zero unexpected upstream requests, medians/p95, and 159 source/artifact records. Warm measurements use five alternating rounds, one-second warmups and three-second samples at one and ten connections. Each arm has its own A/A control. Cold comparisons use twenty samples per arm, timing process launch through the first verified response and excluding shutdown.

Environment: Apple M1 with eight logical CPUs, darwin 25.2.0 arm64, Node 24.21.0, Go 1.27.4 and Wasmtime 50.0.2. Ordinary operating-system activity remains present; preflight/postflight process snapshots and each report's load averages are retained. These results are a separate comparison and are not combined with earlier runs.

| Connections | Baseline / combined / TypeScript req/s | Combined / baseline | Combined / TypeScript |
| ----------- | -------------------------------------: | ------------------: | --------------------: |
| 1           |                  6,310 / 7,159 / 9,080 |              1.135× |                0.788× |
| 10          |               10,450 / 13,021 / 18,248 |              1.246× |                0.714× |

| Connections | Baseline / combined / TypeScript p95 (ms) | Baseline A/A paired ratios | Combined A/A paired ratios | TypeScript A/A paired ratios |
| ----------- | ----------------------------------------: | -------------------------: | -------------------------: | ---------------------------: |
| 1           |                     0.180 / 0.154 / 0.119 |               0.997–1.038× |               0.946–1.010× |                 0.992–1.030× |
| 10          |                     1.657 / 1.332 / 0.575 |               0.994–1.018× |               0.977–1.014× |                 0.983–1.025× |

The combined change improves throughput by 13.47% at one connection and 24.60% at ten, beyond the observed A/A variation. It still reaches only 78.85% and 71.36% of matched TypeScript throughput, with higher p95 latency. This comparison includes the identical writer fix in both arms; it does not measure the total change from the unmodified production SDK.

Local process cold-start median/p95 is 7.795/8.179 ms for the baseline, 7.960/8.658 ms for the combined candidate, and 49.436/51.652 ms for TypeScript. The candidate median increases by 0.166 ms. Baseline/candidate A/A median differences are −0.047/+0.028 ms, and TypeScript's is +0.819 ms. No cleanup-related cold-start improvement is established. The native process advantage over Node does not establish a provider cold-start result.

The baseline/candidate component sizes are 7,080,514/7,096,534 bytes before precompilation and 13,976,488/14,015,816 bytes after precompilation. The host remains 8,404,320 bytes. The manifest records exact hashes for the generator sources, both complete SDK source sets, benchmark scripts and artifacts; raw reports, command records and the summarizer remain in the owned experiment directory.

## Decision

Retain the combined change as a measured optimization candidate. Correctness and throughput improve, but the remaining TypeScript gap prevents performance acceptance. Production integration, cross-platform and packed checks, provider measurements, and the upstream maintenance path remain unverified. Do not silently patch caller SDK dependencies or merge on the strength of this one-workload result.
