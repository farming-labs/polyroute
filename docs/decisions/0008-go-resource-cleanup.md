# 0008: Investigate cancellation of completed Go resource cleanups

Status: isolated experiment measured, 2026-11-18. No production compiler, dependency, or runtime behavior has changed.

## Problem

The Go guest profile points to `runtime.AddCleanup` and `runtime.addspecial` during request bridging. The generated bindings in `go.bytecodealliance.org/wasi` v0.1.2 register cleanup for every owned resource, but discard the returned `runtime.Cleanup`. Explicit `Drop` and `TakeHandle` consume the handle without cancelling that now-redundant registration. The current upstream generator uses the same mechanism.

This is separate from the pinned-allocation experiment in ADR 0006. That experiment established bounded memory without a throughput improvement. Do not combine its hook or change the 1,000-request replacement limit in this comparison.

## Experiment

- Copy the matching upstream generator and SDK into an owned temporary directory. Patch the generator source, then regenerate bindings; never hand-edit generated bindings or the shared module cache.
- Retain the cleanup registration on each owned wrapper. Cancel it only when an explicit drop or ownership transfer consumes the wrapper. Keep the wrapper reachable across cancellation, as required by Go's `Cleanup.Stop` contract.
- Keep garbage-collection cleanup for resources callers abandon. Borrowed wrappers must not acquire ownership or register an owning cleanup. Audit `SetHandle` and ownership round trips before choosing where cancellation belongs.
- Preserve public generated methods and resource ownership, including repeated drops, use after transfer, and copies sharing a handle. Do not remove cleanup or globally disable collection to obtain a faster benchmark.
- Build real components against regenerated original and candidate SDKs using a local module replacement. Preserve the route source and host. No dependency change or upstream publication is authorized by this experiment.

## Verification

First prove that baseline regeneration reproduces the published bindings byte-for-byte. Test resource disposal and transfer with real components, including explicit drop, forgotten resources, repeated operations, forced collection, retained values, and outbound streams. Retain any failure rather than reducing coverage.

Only after compatibility checks, compare the identical slug workload using five alternating production HTTP rounds, one-second warmups, three-second samples, both A/A controls at one and ten connections, and twenty cold samples. Record raw results, p95, environment, correctness, and artifact sizes. A gain within control variation is inconclusive. A lifecycle fix alone does not meet the broader TypeScript goal.

## References

- [Pinned generator source](https://github.com/bytecodealliance/wit-bindgen/blob/v0.62.0/crates/go/src/lib.rs).
- [SDK regeneration instructions](https://github.com/bytecodealliance/go-wasi/blob/v0.1.2/regenerate_bindings.sh).
- [Go cleanup cancellation contract](https://pkg.go.dev/runtime#Cleanup.Stop).

No upstream issue, comment, or pull request has been created.

## Generator provenance

The published SDK header names wit-bindgen 0.62.0, but the v0.62.0 tag (`c604ee01c03f50d7301984a3c920a650752cd136`) does not reproduce its constant names and whitespace. Its CLI also predates the SDK regeneration script’s `--quiet` and directory layout. The isolated baseline generator restores the SDK’s underscore-separated constants and getter spacing in generator source, then maps the CLI output directories explicitly. All 65 regenerated WASIp2 files match the published SDK byte-for-byte. The cleanup candidate is a separate source patch on that reproduced baseline. Neither generated files nor the shared module cache were hand-edited.

## Ownership and HTTP checks

The native resource probe passed 20 scenarios (ten per variant), with 256 resources in each scenario. The original bindings queued and executed 256 redundant callbacks after explicit drop, restore/drop, or copied-wrapper disposal while the original wrapper remained reachable, and 512 after transfer to another owning wrapper and disposal. The candidate queued zero for those operations. Both variants still executed 256 cleanups for forgotten resources and for resources forgotten after `TakeHandle`/`SetHandle`. Using the forgotten handles trapped in the host, and the next request recovered with a fresh instance. Borrowed wrappers did not dispose their live owners. Forced collection while a restored owner remained reachable preserved its fields.

The broader production HTTP probe passed 574 checks and failed two: one identical oversized Go response in each native variant. Both jco variants passed all 144 cases. Both native variants passed 143, including outbound GET/POST, 64 KiB request bodies, denied hosts, denied redirects, decompression, three concurrent upstream requests, and 128 retained-body/hash checks with forced Go collection. A response consisting of a 1 MiB binary payload plus its text prefix and suffix trapped with `write exceeded budget` in both native variants. The current SDK calls `OutputStream.Write` without first checking its permitted size. Wasmtime enforces a 1 MiB per-write budget; the portable host advertises that budget but does not enforce it. Cancellation does not fix this SDK bug. The failing assertions remain failed and their logs are retained.

An accidentally started timing run was terminated as soon as the HTTP failure was inspected; its partial output is retained separately as interrupted and is not an accepted benchmark. The subsequent slug comparison measures only that unchanged, short-response workload. It cannot establish full HTTP compatibility or justify integrating the candidate while the oversized-response failure remains.

Copying a resource wrapper and allowing its original wrapper to become unreachable was not established as safe by these tests. The original SDK attaches cleanup to the wrapper rather than its shared handle; that broader ownership concern remains outside this isolated cancellation experiment.

## Slug throughput result

The isolated comparison used the same production server, native addon, slug source, and 1,000-request replacement limit. Only the component built against the regenerated SDK changed. Environment: Apple M1, eight logical CPUs, macOS kernel 25.2.0, Node 24.21.0, Go 1.27.4, Wasmtime 50.0.2. Each report contains five alternating rounds, one-second warmups, three-second samples, and matched TypeScript. Both A/A controls ran at each connection count. All accepted slug samples passed response validation, with zero errors and zero discarded samples. The separately interrupted run is not an accepted report.

| Connections | Original / candidate (req/s) | Candidate / original | Original / candidate p95 (ms) | Matched TypeScript (req/s) |
| ----------- | ---------------------------: | -------------------: | ----------------------------: | -------------------------: |
| 1           |                5,425 / 5,911 |               1.090× |                 0.207 / 0.195 |                     11,127 |
| 10          |               8,657 / 10,233 |               1.182× |                 2.136 / 1.732 |                     26,902 |

At one connection, the A/A median ratios were 0.987× and 0.994×, with all paired control ratios spanning 0.953–1.060×. At ten, the median ratios were 1.004× and 0.978×, with paired control ratios spanning 0.954–1.012×. The candidate’s median gain exceeds that observed control variation. It still loses to matched TypeScript. This local prototype is not a production optimization or completed acceptance. The precompiled Go component increased from 13,976,136 to 14,015,440 bytes.

Twenty alternating cold samples per build measured 54.118 → 54.250 ms to the first correct Go response; p95 was 55.770 → 58.743 ms. The matched TypeScript median was 49.496 ms, p95 51.501 ms. The candidate median changed by +0.132 ms; the original and candidate A/A median differences were −0.240 ms and +0.004 ms. There is no cold-start improvement. All cold samples returned the expected response, and none were discarded.

## Reproduction artifacts

The local experiment directory `polyroute-go-cleanup-probe-20261118` contains the pinned generator, compatibility and cleanup source patches, regenerated SDKs, component builds, hashes, HTTP/resource test programs, and raw warm/cold reports. No SDK patch is installed in Polyroute.

Commands executed from that directory:

- `node build-resources.mjs` and `node check-resources.mjs`: both components built; 20 resource scenarios passed.
- `node build-http.mjs` and `node check-http.mjs`: four production builds; 574 checks passed and two oversized-response assertions failed. Those failures remain recorded.
- `python3 slug/run.py`: six complete reports, five alternating rounds each, both A/A controls, zero slug response errors.
- `python3 slug/run-cold.py`: three complete reports, twenty samples per route/build, zero discarded samples.
- `python3 slug/summarize.py` and `python3 slug/summarize-cold.py`: validated complete reports and produced the tables above.

The accepted timings used Node 24.21.0. The generator was built with `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo build --locked --no-default-features --features go --bin wit-bindgen`. The Go components used `go tool componentize-go build -o <artifact>`, with an explicit local SDK replacement. No cleanup-candidate Linux, Windows, Node 22, packed-package, or provider result is claimed.
