# RFC 0001: Compile routes ahead of time and run them natively

Status: proposed, 2026-11-16. Prototype and measurement status updated 2026-11-18.

## Summary

Two changes, in this order:

1. **Stop inlining route WebAssembly into the server bundle.** Write each route's core modules to files next to `server.js` and load only the ones a request needs. This needs no native code and works on every target. It also makes TypeScript routes start faster.
2. **Add an opt-in native runtime.** `experimental.runtime: "wasmtime"` would run routes through a Node-API addon that embeds wasmtime. The addon loads machine code compiled at build time (`.cwasm`) for the deploy target. jco stays the default, and it stays the only runtime on targets that can't load addons.

Standalone native functions with no Node process are listed under [Future work](#future-work). Whether to build them depends on what part 2 measures.

## Goal

A Rust, Go, or Python route should be able to replace a TypeScript API route on serverless. That means it starts about as fast and adds little per-request overhead. When it does real work, it should be faster.

The broader performance goal is to beat matched TypeScript workloads in requests per second and cold start on serverless. Beating jco alone does not prove that goal. The benchmark must run equivalent TypeScript algorithms and payloads, and report workloads where native execution loses.

## Measurement correction

The cold-start tables below are historical, not current acceptance evidence. The existing `bench --cold` timer included process shutdown after the first response. [PR #23](https://github.com/farming-labs/polyroute/pull/23) corrects that timer and adds a regression test that fails with the old mechanism. Rerun the cold comparisons before deciding whether either part meets its timing target. Earlier standalone and kernel measurements also need reproduction under the new matched protocol before making a serverless performance claim.

Local process startup does not measure a provider's scheduling, artifact download, or initialization overhead. Provider cold-start claims require a named deployment target and measurements from that deployment.

## Where the time goes today

All numbers are from an Apple M1 (8 cores, 16 GB), macOS 26.2, Node 24.21.0, wasmtime 50.0.1, and rustc 1.99.1. The app is the example app built from main at a197f80. Other processes were running during some runs, so each table says how loaded the machine was. Read the ratios, not the absolute numbers.

### Compute: V8 already runs WebAssembly close to native speed

The same Rust function was built natively, as a WebAssembly command for wasmtime, and as a core module for V8. A JavaScript port ran in the same Node process. Each call was timed in a loop after warmup.

| Kernel                                                                      |   Native | wasmtime | V8, WebAssembly | V8, JavaScript |
| --------------------------------------------------------------------------- | -------: | -------: | --------------: | -------------: |
| Count primes below 100,000, median of 3 rounds                              | 2,666 µs | 2,541 µs |        2,158 µs |       4,072 µs |
| Generate, sort, and fold 200,000 `u32`s, median of 5 rounds, loaded machine | 4,544 µs | 5,786 µs |        4,938 µs |       7,150 µs |

Per core, Rust compiled to WebAssembly is already 1.4–1.9× faster than JavaScript inside polyroute. A different engine wouldn't make a route's own code faster. wasmtime's lead in the README's throughput numbers comes from running requests on several threads at once. A serverless instance handles one request at a time, so it doesn't get that lead.

### Cold start: most of it is the bundle, not the engine

We measured cold start as the time from spawning a fresh server process to the first correct response. Each cell is the median of 5 runs, and the two values are two separate passes. Load average was 15–17.

| Server                                            | Route      |   Cold start |
| ------------------------------------------------- | ---------- | -----------: |
| Node, a 3-line `http` server (floor)              | –          |   52 / 50 ms |
| Node + polyroute                                  | TypeScript | 196 / 193 ms |
| Node + polyroute                                  | Rust       | 194 / 209 ms |
| Node + polyroute                                  | Go         | 235 / 237 ms |
| Node + polyroute                                  | Python     | 253 / 271 ms |
| `wasmtime serve`, `.cwasm` compiled ahead of time | Rust       |   19 / 17 ms |
| `wasmtime serve`, `.cwasm` compiled ahead of time | Go         |   20 / 21 ms |
| `wasmtime serve`, `.cwasm` compiled ahead of time | Python     |   24 / 31 ms |

The TypeScript route never touches WebAssembly, and it still pays about 145 ms over the floor. That's because today's `server.js` carries every route's core modules as base64 strings: 18 modules, 35 MB of the 37.4 MB bundle. Reading and parsing the bundle alone took about 170 ms. Removing those strings, which a TypeScript request never uses, cut the TypeScript route's cold start by more than half (load average about 18, median of 7):

| Bundle                                 |         Size | Cold start, TypeScript route |
| -------------------------------------- | -----------: | ---------------------------: |
| Floor (3-line `http` server)           |            – |                 110 / 124 ms |
| As built                               | 37,436,982 B |                 415 / 388 ms |
| Base64 core modules replaced with `""` |  2,203,670 B |                 178 / 184 ms |

Compiling at build time matters as much as the engine does. Without a `.cwasm` file, wasmtime has to compile the component when the process starts:

| Component | `.wasm` | `.cwasm` | `wasmtime compile`, 8 threads |  1 thread | Cold start, compiling at startup |
| --------- | ------: | -------: | ----------------------------: | --------: | -------------------------------: |
| Rust      |  260 KB |   719 KB |                        140 ms |    285 ms |                           265 ms |
| Go        |  7.1 MB |  14.0 MB |                      2,089 ms |  5,085 ms |                         3,732 ms |
| Python    | 19.0 MB |  32.5 MB |                      4,190 ms | 15,239 ms |                         3,186 ms |

The last column was measured with load averages between 40 and 90, so it's high. A function with one vCPU would see something close to the single-thread column on every cold start. A native runtime therefore has to load machine code built ahead of time. Compiling at startup would be slower than what polyroute does today.

`.cwasm` files are tied to their target. The arm64 macOS wasmtime refused an `aarch64-unknown-linux-gnu` `.cwasm` with `Module was compiled for operating system 'linux'`. The Homebrew build couldn't compile for `x86_64` at all (`Support for this target is disabled`), so cross-compiling needs a wasmtime built with every Cranelift backend.

### Per request: a light route's floor is Node's HTTP server

These are closed-loop clients against a single server, median of 3 alternating rounds of 3 s each, with every body checked. Load average was 8–11. `wasmtime serve` used its default for WASIp2 components, which is a new instance for every request.

| Route                                | 1 connection: polyroute | wasmtime, new instance per request | 10 connections: polyroute | wasmtime, new instance per request |
| ------------------------------------ | ----------------------: | ---------------------------------: | ------------------------: | ---------------------------------: |
| Node, 3-line `http` server (ceiling) |            12,388 req/s |                                  – |              23,121 req/s |                                  – |
| TypeScript                           |                   9,928 |                                  – |                    24,837 |                                  – |
| Rust, little work                    |                   7,748 |                              7,737 |                    15,002 |                             17,299 |
| Rust, primes below 10,000            |                   3,532 |                              3,593 |                     5,933 |                             11,674 |
| Go                                   |                   3,921 |                              1,288 |                     5,977 |                              3,471 |
| Python                               |                   3,561 |                                546 |                     5,548 |                              1,255 |

Go and Python lose badly when wasmtime starts a new instance for every request, because their language runtimes start up again each time. That's why [ADR 0001](../decisions/0001-reuse-route-instances.md) made reuse polyroute's default, and a native runtime has to keep it. With `--max-instance-reuse-count 1000000`, wasmtime pulled ahead. These are paired runs, 9 rounds of 2 s with the order flipped every round, and the table shows the median of wasmtime's req/s divided by polyroute's:

| Route                     | 1 connection | 10 connections |
| ------------------------- | -----------: | -------------: |
| Rust, little work         |        1.55× |          1.54× |
| Rust, primes below 10,000 |        1.03× |          2.53× |
| Go                        |        1.59× |          2.96× |
| Python                    |        1.15× |          1.58× |

Treat this table as a direction, not a result. Load average was 18–24 the whole time, a bare Node server reached only 8,823 req/s against 12,388 on the quieter machine, and single rounds ranged from 0.3× to 8×. A clean run is part of part 2's acceptance.

At one connection, which is how a serverless instance sees traffic, a light Rust route runs at 0.12 ms p50, the TypeScript route at 0.08 ms, and the bare Node server at 0.07 ms. Profiled in-process after [#13](https://github.com/farming-labs/polyroute/pull/13), a Rust request spends 41% of its time in jco's generated bindings and 7% in the route's own WebAssembly. A native runtime replaces those bindings with one Node-API call and a copy of the request. It can't go below the Node HTTP floor while it runs inside Node.

### What this means

- **Light routes** can get close to TypeScript, but not past it, while they run inside Node. What's left is the boundary crossing.
- **Heavy routes** are already 1.4–1.9× faster than JavaScript per core. A native engine adds little per core. Threads help a Node server with many cores, not a serverless instance.
- **Cold start** is where the gap is large. Part 1 removes most of it for every route, TypeScript included. Part 2 removes the WebAssembly compile on top of that.

## Part 1: write route WebAssembly to files

**Status: landed in [#16](https://github.com/farming-labs/polyroute/pull/16).** Cold start dropped by 47–57% on every route of the example, from 324 to 139 ms for TypeScript and from 486 to 235 ms for Python, measured with `bench --cold` at a load average of about 20. The first acceptance item below isn't settled. The example imports every route up front, so its server still parses about 2 MB of jco bindings when it starts, and a lazy route table measured inconclusively on the loaded machine.

**Change.** jco's async instantiation asks the runtime for each core module by name through `getCoreModule`. Today the plugin writes every module into the route module as a base64 string (`coreModules` in `transpile.ts` and `plugin.ts`), and `getCoreModule` decodes and compiles it on the route's first request. With this change, the build writes each module to `polyroute/<content-hash>/<name>.wasm` next to the chunk that holds the route module, and `getCoreModule` reads that file. Vite drops emitted assets from server builds, so the files are emitted after Vite's own `generateBundle` hook. Compiling still happens on first use, so a process only reads and compiles the routes it serves.

**Compatibility.**

- `server.js` is no longer a single file. The README says the built server "needs Node, nothing else", and that stays true: the files are plain WebAssembly next to it. Anyone who copies only `server.js` will break. Open question 4 asks whether a single-file mode should stay.
- Serverless bundlers have to carry the files. Referencing them as `new URL("./…", import.meta.url)` is the usual way to make file tracers such as Vercel's pick them up. We haven't verified that on Vercel or Netlify, so each deploy adapter's smoke test has to check it.
- Cloudflare Workers can't read files, but it can import `.wasm` modules. A Workers target would import them instead of reading them.

**Acceptance.**

- A TypeScript route's cold start is within 15 ms of the same app built with no WebAssembly routes.
- No WebAssembly route's first response gets slower.
- `scripts/bench.mjs` gains a `--cold` mode that spawns fresh servers and reports time to the first correct response. The README's Performance section reports it.

## Part 2: `experimental.runtime: "wasmtime"`

### Prototype status

[PR #23](https://github.com/farming-labs/polyroute/pull/23) implements a private Wasmtime 50.0.2 addon for Rust, Go, and Python. It compiles for the building machine and emits the addon and precompiled components beside the server. The default runtime remains jco. No new performance win or completed acceptance is claimed yet.

The prototype differs from the proposed end state below:

- `experimental.targets`, cross-compilation, and prebuilt distribution are not implemented. The compiler-free deployment addon passed the full integration matrix in PR #23; Cranelift stays in its separate build-time binary.
- Development still uses jco and reports this explicitly. Native development parity remains unimplemented.
- Routes without outbound imports use the synchronous Node-API path. Outbound routes use Tokio workers and call the existing JavaScript HTTP host, enforcing its allowlist and cancellation. At most 32 requests per route run concurrently; excess calls wait. This also bounds native per-request mode.
- Outbound Rust, Go, and Python integration, workspace/packed smoke, and the full Linux/macOS/Windows matrix on Node 22 and 24 passed at `7daf491` ([CI run](https://github.com/farming-labs/polyroute/actions/runs/44295931880)). The compiler-free addon also passed this matrix at `d868f630` ([CI run](https://github.com/farming-labs/polyroute/actions/runs/44299249298)). Passing these checks is separate from the throughput and cold-start acceptance below.

The [baseline CI benchmark report](../benchmarks/2026-11-18-native-runtime.md) and the [full comparison after the compiler split and Python transfer optimization](../benchmarks/2026-11-18-native-runtime-python-transfer.md) do not clear the throughput gate. Cold medians remain within the RFC’s allowance but higher than matched TypeScript. The later run completed every A/B and A/A report with zero reported errors and no discarded samples; the Linux relay still loses to jco at one connection, while Go and Python trail TypeScript at both connection counts on both runners. These runs use different environments and cannot establish a before/after optimization gain. The local compiler split reduced addon size by 62.4%; it did not establish a timing improvement and showed a Rust throughput loss that did not reproduce in a focused repeat. No serverless-provider measurement or completed acceptance is claimed.

The proposed configuration and packaging below describe remaining design work; they are not currently supported APIs.

### Configuration

```ts
polyroute({
  experimental: {
    // "jco" (the default) or "wasmtime".
    runtime: "wasmtime",
    // Machine code to build for. Defaults to the build machine's own target.
    targets: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  },
});
```

`targets` is explicit because polyroute is a Vite plugin and doesn't know where the app will be deployed. If a framework above it does know, it can pass the targets in. See open question 2.

### Packages

- **`@farming-labs/polyroute-wasmtime`** is a Node-API addon built with napi-rs on the `wasmtime` and `wasmtime-wasi-http` crates. It ships prebuilt binaries as per-platform optional dependencies and is an optional peer of `@farming-labs/polyroute`.
- **The runtime build has no compiler.** The addon that gets deployed only deserializes `.cwasm` files, so it can leave Cranelift out. The local prototype measured a 62.4% smaller addon (see ADR 0005), and a missing `.cwasm` can never turn into a JIT compile at cold start. The build step uses a build that includes Cranelift. Both builds pin one wasmtime version, because a `.cwasm` only loads in the wasmtime version that wrote it. wasmtime returns an error for any other version.

### Build

For each route and each target, `vite build` calls `Engine::precompile_component` with a fixed `Config` and writes `polyroute/<content-hash>/<target>.cwasm` next to the route's chunk, the same way part 1 places core modules. The build fails if the addon isn't installed or a target isn't supported. It never falls back to jco on its own.

### Request path

1. On a route's first request, `Component::deserialize_file` maps the `.cwasm` into memory, and `ProxyPre` pre-links it once.
2. Each request makes one Node-API call. The call passes the method, path and query, headers as a flat array, and the body as a `Buffer`. It returns the status, headers, and body. Streaming bodies come later.
3. Instances follow [ADR 0001](../decisions/0001-reuse-route-instances.md). `"reuse"` keeps one store and instance per route, a trap retires the instance, and `requestsPerInstance` applies. Go keeps its 1,000-request limit until the pin leak is fixed upstream.
4. The guest call runs synchronously on the JavaScript thread, the same as jco today, so a serverless instance behaves exactly as it does now. Moving calls to worker threads for servers with many cores is a later, separate option.

### Errors and capabilities

- The same `PolyrouteError` codes apply. `ROUTE_TRAPPED` carries the trapped request's stderr, as it does today.
- A new code, `RUNTIME_UNAVAILABLE`, covers a missing addon, a missing `.cwasm` for the host, or a version mismatch. Its message names `experimental.targets` and the host's target triple.
- Capabilities don't change. There are no preopened directories, sockets are denied, and outbound HTTP follows the same allowlist as the jco runtime. The jco allowlist has landed. The native prototype enforces it through wasmtime-wasi-http request hooks and the same JavaScript HTTP host.

### Safety

`Component::deserialize` is `unsafe`: a crafted `.cwasm` could run arbitrary machine code. polyroute only loads `.cwasm` files it wrote at build time, from paths relative to the bundle, and never from request data. The deploy artifact is the trust boundary, the same as for `server.js`.

### Dev server

When the runtime is enabled, `vite dev` uses it too. It compiles for the host and uses wasmtime's compile cache, so dev and production run the same engine.

### Acceptance

Part 2 stays experimental until a prototype clears all of these on macOS arm64 and Linux x64:

- Each WebAssembly route's cold start is within 30 ms of a TypeScript route's in the same app, after part 1.
- Throughput beats jco on every language at both 1 and 10 connections, measured with `scripts/bench.mjs`.
- `pnpm smoke` and `pnpm smoke:packed` pass with the runtime enabled.
- The function fits the platforms' size limits (Vercel: 250 MB unzipped).

Use equivalent workloads, verified response bodies, equal connection counts, and the same Node version. Interleave A/B rounds and run A/A to measure noise. Record every sample, warmup settings, errors, median and p95, CPU/OS details, and artifact sizes. Do not discard losses or omit the outbound relay from smoke or performance acceptance.

If the prototype misses these, we stop and keep part 1. Completing the integration suite alone does not justify merging the native runtime or claiming that it beats TypeScript.

## Alternatives considered

- **Keep thinning jco's glue.** [#13](https://github.com/farming-labs/polyroute/pull/13) raised non-TypeScript throughput over HTTP by 25–55%. jco's bindings are still 41% of a light Rust request, but every further cut patches generated code that jco can change in any release. It doesn't help cold start.
- **Compile Rust routes directly to a Node addon.** This is the fastest option for Rust because it has no WebAssembly boundary. But it works only for Rust, needs a native build of user code for every platform, and loses the sandbox. polyroute is multi-language, so this doesn't fit.
- **Run `wasmtime serve` as a sidecar.** That means two processes and a network hop per instance, and most serverless platforms can't run it.
- **Worker threads with jco.** This helps a Node server with many cores. It does nothing for a serverless instance or for cold start.
- **V8's compiled-code cache.** Node has no public API to save compiled WebAssembly to disk. We haven't verified that, and using V8's cache would need a native addon anyway.

## Costs and risks

- **A native dependency.** Prebuilds per platform, install failures, glibc versus musl, and Windows.
- **Version lockstep.** The build and runtime packages have to move together, and every wasmtime upgrade invalidates every `.cwasm`.
- **Opting in changes the deploy story.** Apps that opt in need a native addon on the server, so the README's "needs Node, nothing else" no longer holds for them, and the README has to say so.
- **Platform support isn't verified.**
  - Vercel Node functions with `.node` files: a Vercel release note describes fixing corrupted `.node` files during tracing.
  - Netlify and AWS Lambda.
  - Bun's and Deno's Node-API support.
  - Cloudflare Workers can't load addons, so jco stays there.
- **Two runtimes to keep at parity.** Errors, instance semantics, and capabilities all have to match. The smoke suite would run both runtimes.

## Rollout

1. Part 1, including `bench --cold` and the README numbers. Done in [#16](https://github.com/farming-labs/polyroute/pull/16).
2. A part 2 prototype on a branch: Rust only, macOS arm64 and Linux x64, measured against the acceptance list. Stop here if it misses.
3. Go and Python, Windows, prebuild CI, and docs.
4. Rename `experimental.runtime` to `runtime`, keeping the old key as a deprecated alias, once it has held up in real apps.

## Future work

**Standalone native functions.** On platforms with a custom runtime, such as AWS Lambda's `provided.al2023`, a non-TypeScript route could deploy as its own binary: wasmtime plus the route's `.cwasm`, with no Node process. `wasmtime serve` with a `.cwasm` file already starts and answers in 17–31 ms, against 50 ms for an empty Node server. The cost is a split deployment, with TypeScript routes in Node and others native, plus per-platform adapters. Part 2's numbers decide whether that's worth it.

## Open questions

1. Is an optional native dependency acceptable for polyroute at all?
2. Should `targets` come from a deploy target, for example a Farm.js `deploy` config, instead of being set by hand?
3. Which platforms come first for part 2 and for standalone functions?
4. Should part 1 keep a single-file mode for people who copy only `server.js`?
