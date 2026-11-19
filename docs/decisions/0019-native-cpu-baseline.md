# 0019: Compile native routes for the target CPU baseline

Status: implemented, 2026-11-18. Local, packed and full CI checks pass. The rebuilt private Vercel probe passes basic native and TypeScript response checks; provider performance remains unmeasured.

## Problem

The first Vercel deployment of the verified Linux probe (`df36bf7`, CI run `44395448679`) reached READY but failed its first Rust invocation. Wasmtime rejected `route.cwasm`: `compilation setting "has_avx512bitalg" is enabled, but not available on the host`. The deployment is `dpl_DeuNzbXghDa3v9SCQbK2vrZyfPbC` in the dedicated farming-labs `polyroute-native-probe` project. No provider timing result was collected.

The compiler uses `Config::new()` without an explicit target. Wasmtime therefore enables instruction-set extensions detected on the build machine. The component cache records the OS/architecture triple and Wasmtime version, but not those detected CPU features. Matching the OS and architecture is insufficient when CI and the deployment use different CPUs.

## Decision and scope

Set Wasmtime's compilation target explicitly to the addon's existing `POLYROUTE_TARGET` triple. [Wasmtime's target configuration](https://docs.rs/wasmtime/50.0.2/wasmtime/struct.Config.html#method.target) disables host-inferred CPU extensions when a target is supplied. This fixes the compiler default used by both the addon builds and the private probe without adding a separate compiler or a public option. Keep the existing engine settings and runtime compatibility checks.

Increment the machine-code cache format so earlier host-tuned artifacts are not reused. Preserve existing cache files; rebuilding selects a separate key. The public API, guest authority, OS/architecture restriction, compiler-free deployment and failure behavior remain unchanged. Re-review the probe's production-source digest because the shared compiler implementation changes; its extracted request and worker behavior does not.

## Alternatives and consequences

Disabling only AVX-512 BITALG would leave other builder-specific extensions enabled. Disabling runtime compatibility checks could execute unsupported instructions. A private probe-only compiler would duplicate configuration and leave the addon with the same deployment failure. Explicit target-baseline compilation avoids those failures but may change throughput; previous host-tuned measurements remain historical evidence and do not establish performance for the new artifacts.

## Acceptance and verification

- Before the fix, compile a real Wasm module through the addon's engine and reproduce rejection by a runtime that reports optional CPU extensions unavailable. After the fix, deserialize and execute that module on the same constrained runtime. The test only removes reported features; it never claims unavailable hardware support.
- Seed the previous cache key with invalid bytes, then require `precompileRoute` to build usable code under a new key while preserving the old file.
- Run Rust formatting, Clippy and tests for both feature sets, the focused native route/cache tests, and existing production and packed checks in the Linux/macOS/Windows CI matrix.
- Rebuild the private probe artifacts in Linux CI, retain their hashes, verify its Lambda/Vercel boundaries and redeploy to the dedicated project. Require real native and TypeScript responses before collecting any provider timings.

Portable machine code does not establish serverless performance acceptance. Provider compatibility, response correctness and measured performance remain separate requirements. RFC 0001 records the later decision to merge a demonstrated incremental improvement while keeping the runtime experimental.

## Local verification

On macOS arm64 with Rust 1.99.1 and Wasmtime 50.0.2, the new CPU regression first failed with `compilation setting "has_lse" is enabled, but not available on the host`. After setting the explicit target, the same compiled module deserializes and returns 42 with every optional host feature reported unavailable. The cache regression first returned the seeded old artifact; after the format increment it writes freshly compiled bytes under a different key and preserves the old file.

- `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --locked --features compiler`: six passed.
- `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --locked --no-default-features`: five passed.
- `cargo fmt --all --check`: passed.
- `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo clippy --all-targets --locked --features compiler -- -D warnings`: passed.
- `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo clippy --all-targets --locked --no-default-features -- -D warnings`: passed.
- `pnpm --filter @farming-labs/polyroute-wasmtime build`: both release binaries built.
- `pnpm build` and `pnpm typecheck`: passed.
- `node --test scripts/*.test.mjs` on Node 24.21.0: fourteen passed.
- `pnpm --filter @farming-labs/polyroute exec vitest run test/wasmtime-cache.test.ts` on Node 24.21.0 with the rebuilt release compiler: one passed.
- `pnpm --filter @farming-labs/polyroute exec vitest run test/wasmtime.test.ts` on Node 24.21.0 with both rebuilt release binaries: 23 passed.
- `pnpm smoke --runtime wasmtime` and `pnpm smoke:packed --runtime wasmtime`: fifteen real HTTP checks passed each, including outbound relay and compiler-free deployment validation. The packed run installs fresh tarballs outside the workspace.
- `pnpm lint` and `pnpm fmt:check`: passed.

## CI and provider verification

[CI run 44428563548](https://github.com/farming-labs/polyroute/actions/runs/44428563548) passes all ten checks on `7e4ce3d68a3f8f8f23f512c6426e10aad301cb3c`: Linux/macOS/Windows on Node 22/24, both Rust feature sets, lint and the private Linux probe. The probe passes seven Lambda and six Vercel Rust tests, 23 SDK protocol groups with 1,103 invocations, twenty AWS emulator groups with 1,101 invocations, and 24 Vercel bridge groups with 1,103 requests and matching end messages. One non-Latin-1 header case is skipped, not passed. All six packaged functions pass matched response checks.

Downloaded artifact `14486702487` matches GitHub's SHA-256 `303fe501682b5f75ab375c472f9129c86ac86644e5d0f65a3203dd498caf6358`. All nineteen Build Output files match the manifest, totaling 79,154,547 bytes. Their recorded modes were restored before upload. The native host SHA-256 remains `75874adc1075449fcca1333cbae58eb27479ff70b2b3538e6034e32c07edba74`, matching the failed deployment; the precompiled components changed.

The protected preview `dpl_HBuJcT1HM6baj5u3VDW3HYgEYxBj` passes six actual provider requests: Rust primes below 10,000, the Go slug of `hello`, Python statistics for `[1,2,3,4]`, and each TypeScript twin return HTTP 200 with expected JSON. The optional-CPU startup failure did not recur. These establish basic response correctness on this deployment, not provider resource/deadline behavior or performance.

The separate [current-artifact local startup comparison](../benchmarks/2026-11-18-native-runtime-cpu-baseline.md) retains 1,560 samples and both A/A controls. It establishes an incremental improvement over jco for Rust computation, Go and Python, while retaining the relay's wider control variation. It does not establish a warm-throughput or serverless-provider gain.
