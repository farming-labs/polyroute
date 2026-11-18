# @farming-labs/polyroute-wasmtime

**The Node-API addon behind polyroute's `experimental.runtime: "wasmtime"`: it compiles routes to machine code at build time and runs them in wasmtime.**

You don't import this package. polyroute loads the compiler addon during `vite build` to compile each route, then copies the smaller runtime addon next to the server bundle. Only the compiler addon includes Cranelift. See [the wasmtime runtime](../../README.md#the-wasmtime-runtime-experimental) in polyroute's README.

## What it doesn't do

- **It isn't published.** Build it from this repository: `pnpm --filter @farming-labs/polyroute-wasmtime build` runs `cargo build --release` and writes `polyroute-wasmtime-compiler.node` for builds and `polyroute-wasmtime.node` for deployment.
- **It doesn't cross-compile.** It builds for, and compiles routes for, the machine it's built on. A server on another OS or architecture fails with `RUNTIME_UNAVAILABLE`.

## How it works

- The compiler addon's `precompile(component)` compiles a component with wasmtime 50.0.2 and Cranelift, using the one engine configuration the addon has.
- `new Route(path, options)` maps a `.cwasm` file into memory and links it against WASI 0.2 and `wasi:http`. wasmtime refuses a file that a different wasmtime version or configuration wrote.
- `route.handle(method, url, headers, body)` serves one request synchronously on the calling thread. It returns the response, or names what went wrong, along with what the route wrote to stdout and stderr during the request.

- `route.handleAsync(request, outbound)` runs an outbound guest on Tokio's blocking executor. Up to 32 requests per route run at once; further calls wait before occupying a worker. The callback runs on JavaScript and uses polyroute's existing HTTP host and allowlist. Completed calls release their callback, cancel unfinished upstream work, and return the instance to the pool unless it trapped or reached its reuse limit.

Both binaries use the same engine configuration and version pin. The runtime binary exposes no compiler and can only load precompiled components.

Routes get no preopened directories, environment variables, or arguments, and sockets are denied.
