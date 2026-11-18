# 0009: Investigate Go responses that exceed the stream write budget

Status: upstream SDK bug reproduced and isolated fix verified, 2026-11-18. No production dependency or host limit has changed.

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
