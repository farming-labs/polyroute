# 0009: Investigate Go responses that exceed the stream write budget

Status: upstream fix merged and adopted locally, 2026-11-19. The recommended version and checked-in Go modules use the fix; caller-owned dependencies and host limits remain unchanged.

## Problem

The Go cleanup experiment found that a response with a 1 MiB body plus its echo prefix and suffix traps in the native runtime. The same failure occurs with the original `go.bytecodealliance.org/wasi` v0.1.2 bindings. Its `responseOutparamWriter.Write` calls `OutputStream.Write` with the entire buffer, without checking the write permit. Wasmtime 50.0.2 permits at most 1 MiB per call and traps when the guest exceeds it. The portable host advertises the same permit but does not enforce it, so the bad guest passes there.

The WASI `write` contract requires the guest to check its permit. `blocking-write-and-flush` handles readiness for chunks of at most 4,096 bytes. The SDK already implements that loop, including partial-write counts and errors, in `outgoingBody.Write` for outbound request bodies.

## Proposed experiment

Reuse `outgoingBody.Write` from `responseOutparamWriter.Write` after its existing header reconciliation. Keep the current stream owner and close lifecycle. Do not increase the host's write budget, relax validation, rewrite generated bindings, or combine this fix with cleanup cancellation.

Make the source change only in an owned SDK copy and build real Go components with a local module replacement. Prove the original SDK fails and the candidate passes the exact oversized-response case. Cover empty bodies, chunk boundaries, binary data, repeated writes, status and headers, failures after a partial write, outbound requests, and retained request data in both production runtimes. The module cache and production dependency remain unchanged.

The SDK is an upstream dependency. This experiment does not authorize publishing a fork, opening an upstream issue or pull request, or silently patching users' dependencies during a build. A production integration decision must follow the verified patch and its maintenance implications.

## Sources

- [Response writer in go-wasi v0.1.2](https://github.com/bytecodealliance/go-wasi/blob/v0.1.2/wasihttp/adapter_p2.go).
- [Existing chunked writer](https://github.com/bytecodealliance/go-wasi/blob/v0.1.2/wasihttp/streams_p2.go).
- [Pinned WASI stream contract](https://github.com/bytecodealliance/go-wasi/blob/v0.1.2/wit/deps/wasi-io-0.2.8/package.wit).

## Isolated fix result

The candidate removes the unused `io` import and replaces the response writer’s direct write/flush/error block with:

```go
body := outgoingBody{stream: row.stream}
return body.Write(buf)
```

The exact HTTP probe that failed on the original SDK now passes all 288 checks across production jco and Wasmtime builds. This includes the 1 MiB binary echo plus prefix/suffix, chunk boundaries, outbound calls, concurrency, policy denial, decompression, and 128 retained-body/hash checks per runtime with forced collection. The cleanup-cancellation patch is absent from this candidate.

A second native probe ran six scenarios against each SDK. The original trapped for a single 1,048,577-byte write and for repeated writes ending in that write; the candidate returned all expected bytes with status 202 and both cookies intact. Empty and 4,097-byte writes also passed. With `Content-Length: 4096` and an 8,192-byte input, the candidate returned `n = 4096` plus an error after the second chunk failed. The host rejected the unfinished response rather than returning its partial body. Invalid content length also failed closed. The next valid request succeeded after every scenario. All 12 expected-outcome checks passed.

Commands in the local `polyroute-go-cleanup-probe-20261118` experiment directory: `python3 prepare-writefix.py`, `gofmt -w sdk-writefix/wasihttp/adapter_p2.go`, `node build-writefix.mjs`, `node check-writefix.mjs`, `node build-write-counts.mjs`, and `node check-write-counts.mjs`. These used Go 1.27.4, Node 24.21.0, Wasmtime 50.0.2, and the current production addon on macOS arm64. The source patch, input sources, hashes, components, and complete test results are retained locally. Linux, Windows, Node 22, packed-package integration, and performance of this writer fix have not been measured. No upstream publication or production SDK replacement has occurred.

## Upstream adoption

[go-wasi #4](https://github.com/bytecodealliance/go-wasi/pull/4) merged on 2026-11-19 as `d97e27847973d5b46cdbdd407c4028a0089d394f`. No release tag contains it yet, so Go resolves that upstream commit to `v0.1.3-0.20261119173204-d97e27847973`. The setup guidance, example and test modules pin this canonical version. No fork or generated binding patch is shipped. Existing caller modules are left alone and receive an explicit upgrade command in the README.

The new production-build regression exercises both jco and Wasmtime with binary request bodies of 0, 4,095, 4,096, 4,097, 1,048,576 and 1,048,577 bytes. The echo handler performs one response write including its metadata prefix and suffix. With v0.1.2, the two native responses above the permit fail with `write exceeded budget`, while twelve other assertions pass. With the upstream version, all fourteen pass on Node 22.13.0 and Node 24.21.0, preserving every response byte, status, header and the subsequent valid request.

The Lambda and Vercel shared probe cases now include the same boundary in both instance modes. This is a correctness adoption; the controlled comparison below found no throughput improvement beyond noise. The Go 1,000-request replacement limit, pinning issue, experimental runtime status and public deployment limitations are unchanged.

Local verification of the upstream adoption on macOS arm64:

- `pnpm build` and `pnpm typecheck`: passed.
- `pnpm test`: fourteen script tests and 281 Vitest tests passed; three existing cases are skipped and are not counted as passes.
- `pnpm --filter @farming-labs/polyroute exec vitest run test/go-write-budget.test.ts`: fourteen passed on Node 22.13.0 and Node 24.21.0.
- `pnpm smoke`, `pnpm smoke:packed`, `pnpm smoke --runtime wasmtime`, and `pnpm smoke:packed --runtime wasmtime`: fifteen real HTTP checks passed each.
- `node probes/lambda/prepare.mjs --output <new-fixtures>`: eight real components built.
- `node probes/lambda/check-runtime.mjs --fixtures <new-fixtures>/fixtures.json --binary <previously-verified-bootstrap> --output <new-report>`: 25 groups and 1,117 invocations passed, including both new Go write-budget groups. This uses the unchanged local macOS probe host; it is not a new Linux or provider deployment claim.
- Changed JavaScript/TypeScript passes `oxlint`; changed files pass `oxfmt --check`.

The previously verified same-source compiler and runtime addon binaries were reused; no Rust source changed or new Rust build was claimed. Linux/Windows CI, the Linux emulator and the new Vercel bridge cases remain to run for this follow-up.

### Controlled writer comparison

A separate local run on 2026-11-19 compares v0.1.2 with the merged upstream SDK and a matched TypeScript slug handler. Both Go arms use the identical standalone prototype host and current baseline-CPU compiler, the same route source, and the unchanged 1,000-request instance limit. Neither arm includes cleanup-cancellation, request-disposal or trailer-allocation patches.

Environment: Apple M1 (8 logical CPUs), macOS arm64/Darwin 25.2.0, Node 24.21.0, Go 1.27.4 and Wasmtime 50.0.2. This is an ordinary workstation, not an isolated performance runner. Each warm arm uses five alternating rounds, a one-second warmup and three-second measured interval at one and ten connections. Every response is checked against the expected status and exact body. Separate A/A runs compare each unchanged runtime with itself. Cold startup has twenty fresh-process samples per arm, from process launch to the verified first response, excluding teardown. No warmup precedes cold samples.

| Measurement                         | Old Go SDK | Merged Go SDK | Matched TypeScript |
| ----------------------------------- | ---------: | ------------: | -----------------: |
| Median req/s, 1 connection          |   6,018.60 |      5,932.28 |           8,461.89 |
| Median interval p95, 1 connection   |   0.193 ms |      0.201 ms |           0.140 ms |
| Median req/s, 10 connections        |   9,992.13 |     10,001.29 |          17,294.11 |
| Median interval p95, 10 connections |   1.800 ms |      1.832 ms |           0.639 ms |
| Median local process startup        |   8.182 ms |      8.395 ms |          50.486 ms |
| p95 local process startup           |  10.455 ms |      8.751 ms |          52.980 ms |

The writer change is not a demonstrated throughput optimization: its median req/s differs by -1.43% and +0.09%, while unchanged A/A pairs vary from -5.38% to +6.96% at one connection and -18.89% to +10.19% at ten. Go remains below the matched TypeScript throughput. Go's standalone process starts much faster than the TypeScript process in this experiment, but this is not a provider cold-start result or the public Node addon integration. The writer itself does not demonstrate a startup gain.

All twelve reports passed the identity, sample-count, alternating-order, correctness and artifact-hash audit: ninety warm intervals, 180 cold samples, zero errors, zero discarded samples. Raw reports, command records, components, source snapshots and scripts are retained under the local experiment directory `/tmp/polyroute-go-writer-bench-20261119`; they are not package artifacts. Commands: `node build.mjs`, `python3 run-full.py`, and `python3 summarize.py`. `run-full.py` runs `node measure.mjs --mode cold|warm --comparison ab|aa-baseline|aa-native|aa-ts --connections 1|10` with the settings above. The complete harness is local; this record alone is not a portable reproduction bundle.

Audit SHA-256 values: manifest `49608e70513811d7bd0857afdba780dedfeb4dad978c7c604c8e97a3d6e3816d`; summary `9f0c9da256e701afdd6c210225c2b3269a905e39e2134f1ed78217e0c7bc347c`; measurement script `b40d9d2440d1441e7200691fe9cac9432c9132ce9fe361875daa9a76399b4b08`. The summary contains the hash of each raw report. Large-response correctness, rather than an unproven speed claim, is the reason to adopt this SDK version.

### Linux package coverage correction

The `lambda-probe` job in [run 44640620494](https://github.com/farming-labs/polyroute/actions/runs/44640620494/job/135970438225), at `22a0efc`, built the real Amazon Linux hosts, passed thirteen Rust tests and the full SDK protocol suite (25 groups, 1,117 invocations), and verified fifteen extracted archives. The emulator passed 21 groups, including reused Go echo, but failed before invoking per-request Go echo: the package builder did not emit that configuration. The 1,108 executed invocations exclude the missing case. Vercel checks were skipped after the failure.

The builder now emits the missing Go echo archive, making sixteen configurations for the current shared cases. The archive regression covers both Go echo instance modes and preserves its 1,000-request limit. A second regression collects the route, instance mode and outbound policy requested by `runCases`, then requires exactly one matching extracted package and manifest. This catches missing configurations for every shared case without maintaining another expected-fixture list. Both assertions fail against the previous builder; `python3 probes/lambda/package_test.py` passes all five tests with the fix on Node 22.13.0 and Node 24.21.0.

These tests use synthetic ELF/component bytes to verify the real filesystem and ZIP boundary; they do not execute a Linux host. The emulator cases, runtime code and timeouts are unchanged. The complete emulator and Vercel checks still require a fresh Linux CI run; Docker is unavailable locally.
