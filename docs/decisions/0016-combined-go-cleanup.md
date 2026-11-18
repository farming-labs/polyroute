# 0016: Measure the combined Go cleanup changes

Status: isolated combined candidate passes local correctness checks, 2026-11-18; performance is unmeasured. No production SDK change or upstream publication.

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

The slug artifacts, combined A/B and A/A comparisons, cold samples, production integration, provider measurements and upstream maintenance path remain unverified. Correctness alone does not establish a combined speedup, a TypeScript win, or merge readiness.
