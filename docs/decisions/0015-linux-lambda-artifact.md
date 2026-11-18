# 0015: Verify the native Lambda artifact on Amazon Linux

Status: private probe and Linux CI verification implemented, 2026-11-18; the first Linux run is pending. No Linux artifact or provider measurement is verified yet.

## Problem and scope

ADR 0014 verifies a macOS process against a local Runtime API fixture. Lambda needs a Linux binary, compatible precompiled guest code, a bootstrap entry point, and a package that runs in its operating-system image. Moving the existing prototype into a reproducible private probe makes that next boundary reviewable and testable in Linux CI without granting deployment authority.

## Decisions

- Check the proven adapter into `probes/lambda`, outside the published package. Retain its existing worker, outbound policy, private Python transfers, Go replacement and response contract. This is a private verification probe, not a new public runtime option or supported provider adapter.
- Build the host inside AWS's `provided:al2023` image pinned by digest, with Rust 1.99.1 and the locked Cargo dependencies. Pin and verify the Rust bootstrap download. Building against Amazon Linux avoids accidentally requiring a newer glibc from the CI runner.
- Prepare existing guest fixtures through the current production build-time addon on the same Linux architecture. Load those precompiled components with the compiler-free host inside Amazon Linux. Reject missing, incompatible, or changed artifacts; do not compile or fall back at request time.
- Package one route per function directory: executable `bootstrap`, native host, strict manifest, and component. The bootstrap resolves only its own directory and passes its manifest explicitly. Verify the archive's file set, modes, sizes and hashes after extraction, then run that extracted artifact.
- Exercise the actual AWS Runtime Interface Emulator from the pinned base image. Use the same HTTP API v2 events and expected responses as the local SDK protocol tests. Keep the local protocol fixture for errors and acknowledgement cases the emulator cannot synthesize. The emulator is not proof of provider scheduling, quotas, isolation, cold starts, or req/s.
- CI receives read-only repository permissions and no AWS credentials. Its containers and test servers have explicit teardown. Artifacts have bounded retention. No AWS account access, cloud resource creation, image publication, or deployment is included.

## Alternatives and consequences

A host built on the Ubuntu runner could depend on a newer glibc than Lambda provides. Static-musl packaging is a separate option; this probe does not change libc, engine settings, or CPU features to bypass compatibility failures. Cross-compilation and arm64 remain additional gates rather than claims inferred from x86_64.

The standalone worker originated as an isolated extraction of the Node addon. Retain source provenance and reuse the existing Python resource implementation directly. A later production integration must share the common core and deployment contract; this probe does not silently substitute for that work or enable itself in normal builds.

## Acceptance and verification

Run formatting, lint, Rust tests and Clippy; reproduce the complete local Runtime API suite against the checked-in probe. In CI, build the production compiler and fixtures, build the compiler-free host in Amazon Linux, verify its artifact, and exercise Rust, Go and Python with exact response checks through the emulator. Cover binary data, headers/cookies, reuse, Go replacement, traps/recovery, policy denial, package paths and startup failure. Preserve the failing logs and artifacts.

Only a green run against the checked-in source and extracted package establishes this packaging milestone. Provider deployment and matched cold/warm comparisons, remaining throughput losses, SDK compatibility, full cross-platform acceptance and PR review still gate completion and merge.

## Sources

- [AWS Rust runtime emulator example](https://github.com/aws/aws-lambda-rust-runtime/blob/main/Dockerfile.rie).
- [AWS OS-only runtimes](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-provided.html).
- [AWS Runtime Interface Emulator](https://github.com/aws/aws-lambda-runtime-interface-emulator).

## Local verification before Linux CI

The checked-in probe builds with the locked dependencies and reuses `packages/polyroute-wasmtime/src/python_http.rs` directly. `cargo fmt --manifest-path probes/lambda/Cargo.toml --all --check`, `cargo clippy --manifest-path probes/lambda/Cargo.toml --release --all-targets --locked -- -D warnings`, and the release build pass on macOS arm64. `cargo test --manifest-path probes/lambda/Cargo.toml --release --locked` passes seven tests.

`node probes/lambda/check-runtime.mjs --fixtures <existing-fixtures> --binary <release-host> --output <new-directory>` passes all 23 groups and 1,103 result posts against the checked-in source, using the original local native components. Twenty guest/HTTP groups now share one implementation with the emulator harness. This refactor retains the original assertions and does not establish emulator success.

`python3 probes/lambda/package_test.py` passes three filesystem/archive tests: exact extracted bytes and modes, relative manifest and Go reuse policy, changed-component rejection, and rejection of a non-ELF host. Its synthetic ELF input is a packaging unit fixture, not an executable or platform test. JavaScript formatting/lint and syntax checks pass.

Preparing fresh local fixtures failed with `ENOSPC` in componentization and the atomic transpilation-cache write. The failed log and temporary output remain retained. After recovering 136,073,004 bytes by verified compression, one retry completed componentization but again exhausted space while writing the final `.cwasm` bundle; that failure is retained separately. The compressed files are completed profile reports and copied generator binaries, with recorded SHA-256 verification and restore instructions; they are separate from these build inputs. The existing-component protocol result is not a fresh-fixture preparation claim. Linux CI must verify the new preparation command, real ELF host, extracted packages and AWS emulator before this milestone can pass.
