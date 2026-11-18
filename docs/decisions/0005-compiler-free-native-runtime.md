# 0005: Keep the compiler out of the deployed native addon

Status: proposed, 2026-11-18. Implementation and measurements are pending.

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
