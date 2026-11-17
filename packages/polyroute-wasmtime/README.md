# @farming-labs/polyroute-wasmtime

**The Node-API addon behind polyroute's `experimental.runtime: "wasmtime"`: it compiles routes to machine code at build time and runs them in wasmtime.**

You don't import this package. polyroute loads it during `vite build` to compile each route, then copies the addon next to the server bundle, where the bundle loads it at runtime. See [the wasmtime runtime](../../README.md#the-wasmtime-runtime-experimental) in polyroute's README.

## What it doesn't do

- **It isn't published.** Build it from this repository: `pnpm --filter @farming-labs/polyroute-wasmtime build` runs `cargo build --release` and writes `polyroute-wasmtime.node`.
- **It doesn't cross-compile.** It builds for, and compiles routes for, the machine it's built on. A server on another OS or architecture fails with `RUNTIME_UNAVAILABLE`.
- **It doesn't send HTTP requests for routes.** polyroute's build rejects routes that import `wasi:http/outgoing-handler` when this runtime is on.

## How it works

- `precompile(component)` compiles a component with wasmtime 50.0.2 and Cranelift, using the one engine configuration the addon has.
- `new Route(path, options)` maps a `.cwasm` file into memory and links it against WASI 0.2 and `wasi:http`. wasmtime refuses a file that a different wasmtime version or configuration wrote.
- `route.handle(method, url, headers, body)` serves one request synchronously on the calling thread. It returns the response, or names what went wrong, along with what the route wrote to stdout and stderr during the request.

Routes get no preopened directories, environment variables, or arguments, and sockets are denied.
