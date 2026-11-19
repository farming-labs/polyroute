# 0017: Verify prompt disposal of Go incoming requests

Status: correctness verified in an isolated SDK copy, 2026-11-18. Performance unmeasured: the only timing run was discarded. No production SDK change or upstream publication.

## Problem and scope

The combined cleanup candidate still trails TypeScript. The synchronous Go SDK's `wasiHandle` owns a generated `IncomingRequest` but does not explicitly drop it; its generated cleanup eventually releases that resource. The converted `http.Request.Body` also retains the original consumer. Investigate whether returning from the SDK handler can release the underlying request after its response and body have closed, without shortening the lifetime of copied request data.

This is a separate experiment from avoiding empty trailer allocation. Keep that behavior unchanged. Start both arms from the exact combined SDK candidate in ADR 0016, including its response-writer correction. The only candidate source change is explicit request disposal at the outer SDK handler boundary.

## Decisions

- Reuse the generated `IncomingRequest.Drop` method. Register disposal before the existing defers so response and input-body closure occur first, including error unwinding. Do not replace handles, edit generated bindings, change runtime cleanup behavior, or raise the 1,000-request limit.
- Retain the public `net/http` handler API and copied method, URL, headers, body data and trailers. No host API, authority, compiler, scheduling or route algorithm changes are included.
- Prove the mechanism with a real guest wrapper around the SDK export. Hold the incoming wrapper reachable across dispatch, inspect whether its handle was consumed on return, and separately verify that using the old handle fails in the host. A live wrapper prevents garbage collection from accidentally satisfying the disposal assertion.
- Keep all SDK edits in owned copies with local module replacements. The shared module cache and production dependencies remain unchanged. Upstream publication and the maintenance path remain separate decisions.

## Alternatives and consequences

Relying on later garbage collection retains the present lifetime and its deferred work. Dropping the request before body/response completion could invalidate resources that still need it. A deferred drop at the outermost boundary is the narrow candidate; reject it if real error-path or retained-data tests demonstrate an ownership mismatch. Empty-trailer allocation is another hypothesis and must not be folded into this comparison.

## Verification plan

First run the deterministic disposal assertion against the unchanged SDK and preserve its failure. Then apply the source-only candidate and require the same assertion to pass. Verify host rejection of a stale handle and fresh-instance recovery, ordinary and unread bodies, explicit body close, retained copied request metadata/data, conversion errors, handler traps and subsequent valid requests. Compare exact successful responses and expected failures through native and portable production boundaries where supported.

Only after correctness passes, use the unchanged standalone host and matched TypeScript slug workload for a separate comparison. Retain every arm's A/A controls, alternating rounds, cold samples, medians/p95, source/artifact hashes and failures. Do not build during timing, mix runs, infer a gain from cleanup counts, or claim provider performance from local processes. Full performance acceptance, cross-platform and packed integration, provider measurements and merge readiness remain unproven.

## Correctness result

The owned experiment directory is `/tmp/polyroute-go-request-disposal-20261118`. Its baseline SDK is byte-identical to the ADR 0016 combined candidate (`diff -r` reports no difference). The candidate adds one line to `wasihttp/server_p2.go`, `defer request.Drop()`, registered before the existing response and body defers so those run first.

The disposal probe keeps the incoming wrapper reachable across dispatch. Against the baseline it fails with `The SDK must release its owned incoming request before dispatch returns` (`disposed=false`). The candidate passes with `disposed=true`.

The native lifecycle check passes 38 groups and 2,578 calls with zero failures. It covers stale-handle rejection, fresh-instance recovery, unread and explicitly closed bodies, retained copied metadata and data, conversion errors, handler traps and the 1,000-request replacement. The portable (jco) lifecycle check also passes 38 groups and 2,578 calls. Its first run failed two stale-handle cases because jco reports a stale resource as `Cannot read private member #method from an object whose class did not declare it`, which the broad error pattern did not match. The assertion now requires that exact message, which is narrower than the original pattern. The failed script, log and results are retained beside the passing run. `node check-http.mjs` passes 144 checks each for jco and Wasmtime.

## Discarded timing run

`bench/build-slug.mjs` built both variants from the unchanged example route with the original standalone host (SHA-256 `68853daf7f7343c6185622699185fd7d98f463e3a912968ba35b3a54b92ea54b`) and verified the exact response. The components are not byte-identical to the ADR 0016 builds, probably because the module replacement path is embedded, so this baseline is a fresh arm and is not compared with earlier runs.

The full alternating run completed twelve reports with 90 warm samples, 180 cold samples and zero errors, but the operating system's file sync started during it. The postflight snapshot shows `fileproviderd` at 98% CPU, iCloud `bird` at 48% and a load average of 6.6 on eight CPUs. The A/A controls confirm the contamination: the native A/A paired ratios spanned 0.90–3.18× at one connection and the baseline A/A spanned 0.64–1.13× at ten. The candidate's observed +7.8% (one connection) and −5.4% (ten connections) lie inside that noise, so no throughput effect is claimed in either direction. The reports are kept in `bench/contaminated-icloud-run/` and must not be cited as a result.

Cold-start medians from the same run were 7.92 ms (baseline), 8.18 ms (candidate) and 48.79 ms (TypeScript). These local process numbers carry the same contamination caveat.

## Next

Repeat the identical run once the system is idle, using the same artifacts and harness. Reject the candidate if the clean A/A controls bound the effect below the noise. In either case it does not close the TypeScript throughput gap on its own.
