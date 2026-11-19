# 0005: Keep the compiler out of the deployed native addon

Status: implemented in the experimental prototype, 2026-11-18. Cross-platform integration checks and local measurements are complete; throughput acceptance remains unmet.

## Problem

The native prototype deploys the same addon that precompiles components. It includes Cranelift and constructs a compiler when its engine starts, even though request handling only deserializes trusted machine code. This leaves build-time code in every serverless deployment. RFC 0001 already proposes separate build and runtime addons.

The matched benchmark does not yet establish the requested performance outcome. This change targets native initialization and artifact size. It must not be described as a throughput improvement without measurements.

## Decision

- Build the crate twice. The default build contains the runtime only. A `compiler` Cargo feature adds Cranelift, parallel compilation, and the `precompile` Node-API export.
- Keep one engine configuration, Wasmtime version pin, target, host implementation, and request path. Wasmtime still validates the serialized component's configuration and required CPU features when loading it.
- The npm package contains both binaries. `loadAddon()` continues to return the build-time addon, preserving the private package's existing interface. `addonPath` identifies the compiler-free binary that the plugin copies beside the server.
- The emitted deployment contains only the runtime binary and `.cwasm` files. It does not import the npm package or compiler binary at request time. A missing or incompatible component still fails with no compilation or fallback.
- Keep the current cache key because the component format and engine configuration do not change. Confirm compatibility using real precompiled Rust, Go, and Python routes before accepting this decision.

## Verification

1. Check the deployed binary's actual exports in a short-lived process. The existing binary must fail the assertion that `precompile` is absent. Child exit releases native library mappings before Windows cleanup.
2. Inspect Cargo's resolved feature graph to verify that the runtime build excludes Cranelift and parallel compilation.
3. Run Rust formatting, clippy, and tests for both feature sets, then the full production, workspace, and packed suites. The deployment file inventory must contain only the runtime addon.
4. Reuse the same precompiled route artifacts for an interleaved comparison of the old and new runtime binaries. Record exact binary/deployment sizes and cold-start median/p95, with A/A noise controls. Run warm throughput checks to detect regressions.

The result remains experimental until the original native acceptance and the broader matched TypeScript performance goal are demonstrated. A smaller addon alone does not establish either outcome.

## Implementation evidence

On macOS arm64 with Node 24, the deployed-export regression failed against the compiler-bearing addon and passed against the runtime-only addon. Cargo's resolved features exclude Cranelift and parallel compilation from the runtime. Both feature sets passed `cargo fmt --all --check`, `cargo clippy --all-targets --locked -- -D warnings` with their respective feature flags, and `cargo test --locked` (two tests each).

The package build and type-check passed. The root script suite passed all 12 tests; the route suite passed 154 tests with three skipped. Workspace and packed smoke tests passed all 15 HTTP checks for each runtime. Native smoke also loads the emitted addon in a separate process and rejects a deployment that exposes the compiler or contains multiple native addons. Node 22 passed the native export and route-process checks (three tests).

The cold-start and warm-throughput comparison must use identical precompiled route files and binaries built from the same source, differing only in the compiler feature. Record the compiler-only size difference separately from deployment size and timing.

## Measurement result

[CI run 44299249298](https://github.com/farming-labs/polyroute/actions/runs/44299249298) passed at `d868f630d6584b21bc28b4c0159b69159780b9f3`: Linux, macOS, and Windows on Node 22/24, both native feature sets, formatting, and lint.

The isolated local comparison used the same precompiled production routes and two addons built from the same source, differing only in the compiler feature. On Apple M1, macOS 25.2.0, Node 24.21.0, the addon shrank from 14,263,328 to 5,368,128 bytes (62.4%); the whole example deployment shrank from 62,673,348 to 53,778,148 bytes (14.2%).

Twenty cold samples per route, with both A/A controls, did not demonstrate a cold-start improvement: non-TypeScript median differences ranged from −0.772 to +0.546 ms. Five warm rounds with one-second warmups, three-second samples, and one connection returned correct bodies with no errors. Native throughput after/before ranged from 0.965× to 1.042×. The 10,000-prime Rust route lost 3.5%, larger than its A/A paired variation; that observation is retained rather than dismissed as noise.

This decision removes unused deployment code and reduces size. It does not establish improved throughput or cold start. The separate [CI benchmark report](../benchmarks/2026-11-18-native-runtime.md) also fails the broader native acceptance.

A focused repeat of the 10,000-prime case used fresh server pairs with the same artifacts and the same five-round protocol. It did not reproduce the loss: compiler/runtime medians were 4,129 / 4,154 req/s (1.006×), with p95 0.263 / 0.272 ms. Its runtime A/A median ratio was 1.009× and compiler A/A was 1.053×. Every response was correct. Keep this repeat separate from the original run: the observations do not establish a consistent throughput effect, and they do not justify a speedup claim.
