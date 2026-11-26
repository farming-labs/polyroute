# Ship a WASI HTTP component or a Farm Node server

This local production probe compiles the maintained Rust prime-counting route once. It gives the
same WebAssembly component to Farm's Node build and to a WASI HTTP host. The matched TypeScript
route counts the same primes and returns the same JSON. Both sources come from
`examples/polyglot/app/api`.

The app config uses `vite.plugins: [polyroute()]`. The **probe build script** stages the two route
files and generates Farm's TypeScript forwarding file in its build directory. Direct discovery
by the stock Farm CLI and live reload of new Rust files are outside this experiment.

## Build

Use Node 24, pnpm 10, npm, Rust with `wasm32-wasip2`, and the Wasmtime CLI. From the repo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @farming-labs/polyroute build
npm ci --prefix probes/farm --workspaces=false --legacy-peer-deps
rustup target add wasm32-wasip2
node probes/farm/build.mjs
```

The final line prints a fresh build directory. It contains two independent deployment artifacts:

- `wasi/api/primes/route.wasm` exports `wasi:http/incoming-handler`. The accompanying `routes.json`
  maps the public endpoint to the component. Configure the host to mount it at that path.
- `node/` contains the standalone Farm/Nitro server, including the WebAssembly files its
  JavaScript Fetch adapter loads on the first request. Farm 0.1.87 omits those files from the
  final SSR directory. This probe restores them from Polyroute's compilation output.

To try them separately, set `build` to the printed directory:

```sh
node "$build/node/server/index.mjs"
wasmtime serve -S cli=y --addr 127.0.0.1:8080 "$build/wasi/api/primes/route.wasm"
```

Request `/api/primes?limit=10`. The expected JSON is `{"limit":10,"primes":4}`.
The raw component in this probe is an independently served public route. It receives requests
directly from the host. Farm middleware, base paths, and policies of a Farm deployment only
apply on the Farm server path. The probe refuses routes importing outbound HTTP.

## Measure

```sh
node probes/farm/bench.mjs "$build"
```

The harness copies just the deployment outputs to a fresh temporary directory, starts locally bound
servers, and checks status, content type, and exact response bytes. It also checks that both Rust
outputs reject POST with a 405 and the GET Allow header. It writes all rounds to
`$build/results.json`. The printed sample columns are median round p50 (ms), p95 (ms), and requests/s.

Five local servers serve the same algorithm: Farm TypeScript, Farm Rust through V8, bare Node
TypeScript (stripped before startup), Wasmtime serving the WASI binary, and an identical second
Farm TypeScript server as an A/A noise control. The direct host accepts one guest request at a time
and reuses an instance up to 128 times. Warm runs rotate and reverse order over ten rounds, with
500 ms warmup and 1.5 s of measurement per case at one and ten connections. One workload counts
primes below 2, the other below 100,000. Twenty fresh processes per mode supply a separate
time-to-first-correct-response measurement. Node's disk compile cache is disabled for this run.
All clients run on the server machine. These are local timings, not a provider cold-start or billing
measurement.

For a correctness-only run, use `node probes/farm/bench.mjs "$build" --smoke`.
In this mode, Node's filesystem permissions restrict reads to the isolated deployment directory.
The harness removes its isolated deployment copy after a successful run and retains the original
build directory and the benchmark report.
