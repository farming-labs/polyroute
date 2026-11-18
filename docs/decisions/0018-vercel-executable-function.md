# 0018: Serve the standalone native host as a Vercel executable function

Status: proposed, 2026-11-18. Private probe only. No public deployment target, provider deployment, or provider measurement.

## Problem and scope

On Vercel Node functions, Rust, Go and Python routes can't beat TypeScript on cold start or on trivial routes. Node boots before the addon loads, and each request pays a fixed cost to enter Wasmtime: about 11 µs for a trivial Rust route and about 72 µs for Go, measured by calling `Route.handle` directly on macOS arm64. On CI's Linux x64 runners at ten connections, a trivial Rust route serves 6,552 req/s against TypeScript's 14,800, and every non-TypeScript cold start is 3–10 ms slower than TypeScript's.

The standalone native host (ADR 0010) doesn't start Node. Locally it starts in 5–12 ms against TypeScript's ~49 ms, and Rust handles compute-heavy routes at 1.4–1.7× TypeScript's req/s. The user chose this host as the target. This ADR covers the next boundary: running it as a Vercel function.

## Decisions

- Use Vercel's official Rust bridge, `vercel_runtime` 2.4.1, pinned with the locked dependencies. It runs an HTTP/1.1 server on `127.0.0.1`, reports readiness and request completion over `VERCEL_IPC_PATH`, and serves concurrent requests on Fluid compute. Don't reimplement the IPC protocol.
- Emit what Vercel's own Rust builder emits for a function that depends on `vercel_runtime`: one `executable` file, with `.vc-config.json` setting `"runtime": "executable"`, `"handler": "executable"`, `"architecture": "x86_64"`, `"supportsResponseStreaming": true` and `"runtimeLanguage": "rust"`. Don't use the builder's standalone mode, which puts an extra proxy process in front of the server.
- Add a second binary to the existing private probe crate. It includes the same `core.rs` and `outbound.rs` as the Lambda binary, and both binaries share one transport-neutral route layer: manifest loading, worker reuse, Go's 1,000-request replacement, trap retirement, the outbound policy, and response validation. Each adapter only decodes its transport and encodes the response.
- Pass HTTP header bytes through as Latin-1, matching the Node addon's wire contract. Build the guest URL from the request's `Host` header and `x-forwarded-proto`. Strip Vercel's internal `x-vercel-internal-*` headers before the guest sees the request.
- Fail closed without leaking internals. On a trap, an invalid response, or an adapter error, return `500 Internal Server Error` with that plain body, write the cause to stderr, and keep serving. Don't use `vercel_runtime`'s default error body, which includes the error text.
- Load one trusted precompiled component from a manifest beside the executable. Missing or incompatible artifacts fail at startup, before readiness is reported.

## Alternatives and consequences

The Lambda probe's Runtime API adapter doesn't apply. Vercel invokes `executable` functions through its own bridge, not Lambda's event loop. Vercel's standalone mode would run the host unchanged but adds a proxy hop on every request. Staying on Node keeps the measured losses.

This doesn't change the published packages or public options. A later production change must turn the probe into a build output from the Vite plugin and needs its own review.

## Verification plan

Run Rust formatting, Clippy and tests for both binaries. Run the shared guest cases from `cases.mjs` against the real Vercel binary over HTTP, with a local unix-socket server standing in for Vercel's bridge. Require a `server-started` message before the first request and one `end` message per request, keyed by the request's invocation and request IDs. Cover startup failure before readiness and shutdown on `SIGTERM`. Re-run the Lambda probe's protocol suite to show the shared route layer didn't change its behavior. Linux packaging follows the Lambda probe's pinned Amazon Linux build.

Deploying needs a Vercel project and the user's explicit approval. Only a deployed, matched comparison against an equivalent TypeScript function can establish provider cold-start or req/s results.
