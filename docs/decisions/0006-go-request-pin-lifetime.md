# 0006: Investigate Go pins at the request return boundary

Status: proposed experiment, 2026-11-18. No compiler or runtime behavior has changed.

## Problem

ADR 0001 limits a Go instance to 1,000 requests because allocations returned by `wasi:http` imports remain pinned. The checked-in example uses `go.bytecodealliance.org/pkg` v0.4.1 and `go.bytecodealliance.org/wasi` v0.1.2. Their source confirms the mechanism: `cabi_realloc` pins its allocations in one runtime pinner, and the generated synchronous incoming-handler export does not release it. The runtime already exposes `wit/runtime.Unpin()`.

Replacing an instance bounds the growth but repeats initialization and does not release pins between requests. The matched Go workload still loses to TypeScript. We must measure whether releasing completed request allocations reduces that gap; a memory improvement alone does not establish the performance goal.

## Experiment

1. Check whether the component encoder accepts a canonical post-return function for the void `wasi:http/incoming-handler@0.2.8#handle` export. The function would call the existing `wit/runtime.Unpin()` after the host has consumed the call's results.
2. Prototype the hook in an isolated copied Go fixture. Do not patch the module cache, edit upstream generated bindings, change dependencies, or rewrite the user's handler.
3. Inspect the resulting component to prove that its canonical lift names the post-return hook. An unused core export is not sufficient.
4. Compare otherwise identical components with and without the hook. Keep the existing 1,000-request replacement limit while testing the mechanism.

If the canonical hook works, a later implementation decision must specify how the build supplies its small Go source file without modifying the user's module. The experiment does not authorize removing the reuse limit or introducing an unsupported dependency workaround.

## Lifetime requirements

- The hook must run after a successful exported request, not during `cabi_realloc` or while another guest call is active.
- Go references deliberately retained in guest globals must remain valid after unpinning and collection. Unpinning must not become an implicit reset of application state.
- Incoming bodies, response bodies, headers, outbound calls, and deferred response cleanup must remain correct.
- A trap must continue to retire the instance. Cleanup must not attempt to re-enter a trapped instance.
- Both jco and Wasmtime must execute the same canonical post-return contract. Node 22/24 and every supported OS remain in scope for the build.

## Verification plan

Use a real Go component that retains a small request value in a global, reads substantial request bodies, forces Go collection, and reports live heap bytes and the retained value. Below the existing replacement limit, repeated calls must remain in one instance. The old component must fail a bounded-live-memory assertion and the hook-enabled component must pass without corrupting retained data.

Then run the existing production and packed conformance suites, including Go outbound requests and trap retirement. Measure matching production artifacts with interleaved A/B and A/A samples, record every round and p95, and report losses. Keep this proposal unimplemented if the hook is not a valid canonical ABI mechanism or the lifetime requirements cannot be proven.

## Related upstream work

[wit-bindgen #1613](https://github.com/bytecodealliance/wit-bindgen/pull/1613) fixed a different pinner lifetime in asynchronous exports. [wit-bindgen #1758](https://github.com/bytecodealliance/wit-bindgen/pull/1758) concerns asynchronous parameter blocks. Neither establishes that the synchronous WASIp2 incoming-handler issue is fixed. No upstream issue, comment, or pull request was created for this experiment.

## Isolated probe result

The component encoder accepts the hook. `wasm-tools print --skeleton` on the actual component produced by componentize-go 0.5.3 shows the incoming-handler canonical lift with `(post-return $cabi_post_wasi:http/incoming-handler@0.2.8#handle)`. The jco output also calls the corresponding hook after a successful handle.

On macOS arm64, Go 1.27.4 and Node 24.21.0, both production runtimes executed 128 sequential requests with 64 KiB bodies and forced Go collection. Both original components failed the bounded-growth assertion: live heap grew by 6,343,552 bytes from request 32 to request 128, above the 524,288-byte allowance. Both hook-enabled components passed with zero growth over that interval. Every current body hash, retained first-body hash, retained header, and request counter was correct. The counter confirmed that the runtime did not replace the instance.

An isolated Go `-overlay` build also successfully supplies the source hook without writing into the route module. This establishes feasibility only. Production integration still needs to preserve caller-provided overlays and flags, clean up its own temporary files, and fail clearly on unsupported or conflicting exports. The existing replacement limit remains unchanged. The completed interleaved measurements below do not establish a throughput gain.

## Slug workload result

The same production server, runtime addon, slug source, and 1,000-request limit were used in both variants; only the Go component changed. On the same Apple M1 / macOS 25.2.0 / Node 24.21.0 environment, each comparison used five alternating rounds, one-second warmups, three-second samples, and all response checks. Both A/A controls ran at each connection count. No samples were discarded and no response errors occurred.

| Connections | Original / hook (req/s) | Hook / original | Original / hook p95 (ms) | Matched TypeScript (req/s) |
| ----------- | ----------------------: | --------------: | -----------------------: | -------------------------: |
| 1           |           5,416 / 5,442 |          1.005× |            0.216 / 0.209 |                     11,404 |
| 10          |           8,550 / 8,544 |          0.999× |            2.164 / 2.182 |                     27,241 |

At one connection, the two A/A median ratios were 1.006× and 0.992×; at ten, they were 0.984× and 0.995×. The candidate’s change is within that variation. This establishes a focused memory fix, not improved throughput or the TypeScript goal. Keep the hook out of the production compiler until a separate lifecycle review and regression suite justify integrating the memory fix. Do not remove the Go replacement limit based on this experiment.
