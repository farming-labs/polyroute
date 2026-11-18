# 0014: Test the standalone core through the Lambda Runtime API

Status: isolated adapter passes local Runtime API checks, 2026-11-18. No Linux package, provider deployment, or public adapter is implemented.

## Problem and scope

The standalone process starts faster locally than the matched TypeScript server, but it has no serverless event adapter or deployable artifact. Process startup does not establish provider cold-start performance. Test the next boundary with the existing native core and the official AWS Rust runtime before designing a public deployment API.

The first local prototype targets Lambda Function URL / API Gateway HTTP API v2 events. This is a local engineering assumption while the provider preference remains unanswered. It does not authorize creating AWS resources or accessing an account. Linux packaging, other event sources, streaming, managed-instance concurrency, and deployment measurements remain separate gates.

## Decisions

- Use the official `lambda_runtime` client and `lambda_http` HTTP API request parser. Pin the resolved SDK and dependency lockfile; do not reimplement Lambda event parsing or the invocation protocol. Serialize the narrow HTTP API v2 response envelope directly when the SDK response conversion cannot preserve the existing HTTP contract.
- Reuse the original standalone engine, linker, guest workers, Python transfer interface, outbound policy and pooled client. Preserve Go's 1,000-request replacement and retire trapped instances. No Go SDK optimization or response-writer patch is included.
- Load one explicit trusted precompiled component from a strict private manifest. No user-controlled component loading, public config option, or automatic fallback. The manifest and artifact must be supplied by the build owner.
- Preserve the SDK's complete request URI, decoded body bytes, duplicate headers, and response cookies. Validate response status, headers, and declared length before response serialization; suppress bodies for HEAD, 204, 205, and 304 as in the existing host.
- Deny guest filesystem, environment, arguments, raw sockets and outbound HTTP unless allowed by the existing policy. Host runtime variables and invocation metadata never become guest capabilities.
- Initialize once, handle invocations sequentially through the SDK, and reuse only the existing bounded worker policy. Cancel active outbound work on shutdown. No background work is intentionally retained across completed invocations.
- Keep source and binaries in an owned experiment directory. No production integration, publication, deployment, or performance claim follows from a local Runtime API fixture.

## Alternatives and consequences

Continuing with the Node addon preserves existing deployment adapters but retains Node initialization. A custom polling client would duplicate AWS protocol and event handling. The official SDK supplies that boundary, while a local fixture can exercise real SDK requests without AWS credentials.

The existing native host and its artifacts are macOS-only evidence. A Lambda artifact needs a Linux binary and compatible precompiled components, then a real runtime-emulator or provider check. A local fixture is protocol evidence, not emulation of provider scheduling, limits, networking, isolation, or billing.

## Verification plan

Build against the locked official SDK. Run Rust formatting, Clippy, and tests, then drive the actual binary through a local Runtime API HTTP server. Validate real guest responses for Rust, Go, and Python; exact binary bodies and cookies; query/URI handling; warm reuse and per-request isolation; Go replacement; traps and recovery; invalid responses; default outbound denial and allowed relay; invalid startup manifests; shutdown; and response/error acknowledgement behavior. Preserve failures rather than weakening checks.

Before production integration, verify Linux packaging and trusted artifact compatibility, resource and deadline behavior, the full existing HTTP and policy suites, packed output, and matched provider performance with an equivalent TypeScript function. Deployment requires a concrete reviewable plan and user authorization. The TypeScript throughput goal remains open regardless of adapter correctness.

## Sources

- [AWS Lambda Runtime API](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html).
- [Official Rust HTTP adapter](https://github.com/aws/aws-lambda-rust-runtime/tree/main/lambda-http).
- [HTTP API payload and response format](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html).
- [Custom runtime requirements](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html).

## Response conversion decision after the first probe

The initial `lambda_http::run` build passed thirteen Runtime API groups and failed three. Both Python instance modes returned altered bytes: the SDK's generic `IntoResponse` decodes a response without Content-Type as UTF-8 text, replacing invalid bytes even when the supplied body is `Body::Binary`. A Latin-1 header also caused response serialization to fail and the runtime to exit. Initial results, source, and binary remain retained.

Source inspection also shows that HTTP API v2 cookie conversion uses `HeaderValue::to_str` with an empty-string fallback, while the event serializer selects the first value for an ordinary repeated header. Preserve the tested Polyroute contract with a small response encoder: validate the existing HTTP response first, base64-encode its exact bytes, map Latin-1 header bytes to JSON strings, keep each Set-Cookie separately, and combine other repeated values with commas as HTTP API v2 specifies. This is the adapter's response boundary; it does not replace the official request parser or Runtime API client. The same binary/header regressions must fail on the original adapter and pass after this correction. Provider wire behavior still requires deployment verification.

## Local adapter evidence

The isolated `polyroute-lambda-adapter-20261118` experiment uses `lambda_http` 1.3.2, `lambda_runtime` 1.5.0, and `aws_lambda_events` 1.2.1 with locked dependencies. It calls the SDK's public HTTP request parser and Runtime API client, then serializes the verified HTTP API v2 response envelope. The engine/worker core, outbound implementation, and private Python transfer source remain byte-identical to the original standalone experiment. No Go SDK patch is included.

A further regression reproduced incoming `café` becoming `cafÃ©`: JSON header strings enter the SDK as UTF-8 bytes, while the original HTTP host expects Latin-1 wire bytes. The adapter now decodes those SDK values as UTF-8 and validates the existing Latin-1 contract before calling the unchanged core. A `λ` header previously truncated to another valid byte and returned success; it now produces an invocation error, and the next request succeeds. Both regressions failed before the correction and pass afterward.

Local macOS arm64 verification, Node 24.21.0 and release binary:

- `cargo build --release --locked`: passed after correcting an initial Rust error-conversion mismatch. The failed build log is retained.
- `cargo fmt --all --check` and `rustfmt --edition 2024 --check src/core.rs src/outbound.rs src/python_http.rs`: passed.
- `cargo clippy --release --all-targets --locked -- -D warnings`: passed.
- `cargo test --release --locked`: seven tests passed, including the original resource/policy checks and response serialization tests for exact binary bytes, repeated ordinary headers, separate cookies, Latin-1 values, and empty responses.
- `node check-runtime.mjs`: 23 groups passed through the actual SDK and binary, with 1,103 invocation result posts. The fixture acknowledges 1,101 with 202 and intentionally rejects two with 410 to verify the SDK's diagnostic and subsequent invocation behavior. These rejected acknowledgements are expected cases, not successful deliveries. The SDK logs the stale/timed-out rejection and continues; it does not retry the response.
- `oxfmt check-runtime.mjs` and `oxlint --no-ignore check-runtime.mjs`: passed using the repository's installed tools. An earlier `pnpm --dir` invocation from the experiment directory selected the wrong package-manager version and failed; rerunning from the repository used its pinned version without changing package configuration.

The Runtime API groups cover all three languages, warm reuse/per-request isolation, Go's 1,000-request replacement, trap errors and recovery, exact bodies through 1,048,577 bytes for Python, retained request data, response validation, URI/query/cookie handling, Latin-1 headers, HEAD suppression, malformed events, allowed and denied outbound requests, cancellation of an active upstream call on shutdown, and invalid manifests failing before polling. Initial failed binaries, results, and later passing results remain preserved, with hashes for the final source and binary. A later fixture-counter edit omitted map initialization and produced invalid timeout runs; those logs are retained separately. After correcting the fixture, the complete 23-group run passed again and recorded the acknowledgement counts above.

The fixture is a local protocol server. It is not AWS's Runtime Interface Emulator and proves nothing about provider cold starts or req/s. Docker, Podman, and the AWS CLI were not on the local PATH; no Linux execution was performed. Linux packaging, architecture-compatible precompiled components, emulator/provider execution, provider response-wire behavior, deadline/resource limits, initialization-error reporting, and production/packed integration remain unverified. Only HTTP API v2 is in scope; other event sources and managed-instance concurrency are not implemented. The known upstream Go oversized-response failure remains outside this adapter's passing cases. No deployment, SDK publication, or production integration occurred.
