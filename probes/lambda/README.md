# Native Lambda verification probe

**Build and verify a private, compiler-free Lambda artifact from the standalone native prototype.**

This is an experiment for [ADR 0014](../../docs/decisions/0014-local-lambda-adapter.md) and [ADR 0015](../../docs/decisions/0015-linux-lambda-artifact.md). It does not add a public Polyroute deployment target, deploy resources, or establish provider performance. The fixtures use the merged upstream Go response-writer fix; the shared cases verify large binary responses in reused and per-request instances. The initial Linux target is x86_64 only.

The adapter uses the official AWS Runtime API client and HTTP request parser. Its response encoder preserves exact bytes, Latin-1 headers, repeated ordinary headers, and cookies. Guest capabilities, Go's 1,000-request limit, and trap retirement match the tested standalone prototype. The Python resource implementation is imported directly from the production crate. `provenance.json` pins the production sources from which the isolated worker and policy contract were derived; preparing fixtures fails when those sources change, requiring review before updating that record.

On Linux with Docker, Node 24, pnpm, Rust with `wasm32-wasip2`, Go 1.27, and componentize-py 0.25.1:

```sh
pnpm install --frozen-lockfile
pnpm --filter @farming-labs/polyroute-wasmtime build
pnpm build
python3 probes/lambda/package_test.py
node probes/lambda/prepare.mjs --output /tmp/lambda-fixtures

docker build --platform linux/amd64 --file probes/lambda/Dockerfile \
  --output type=local,dest=/tmp/lambda-host .

node probes/lambda/check-runtime.mjs --fixtures /tmp/lambda-fixtures/fixtures.json \
  --binary /tmp/lambda-host/polyroute-lambda --output /tmp/lambda-protocol
python3 probes/lambda/package.py --host /tmp/lambda-host/polyroute-lambda \
  --fixtures /tmp/lambda-fixtures/fixtures.json --output /tmp/lambda-packages
node probes/lambda/check-rie.mjs --packages /tmp/lambda-packages --output /tmp/lambda-rie
```

Use new output directories for each run. The package builder reads the host and component hashes, writes one function ZIP for each tested configuration, verifies the archive's exact file set, bytes and Unix modes, and extracts it into the named directory. The emulator runs that extracted directory read-only. Each package contains only `bootstrap`, `polyroute-lambda`, `manifest.json`, and `route.cwasm`; it contains no Node runtime, compiler, SDK source, or credentials. The bootstrap resolves its own directory, independent of the caller's working directory.

The Docker build pins the AWS Amazon Linux 2023 image digest and Rust 1.99.1. It verifies the Rust bootstrap checksum, runs formatting, Clippy and seven Rust tests, then builds with locked dependencies. The final export contains the host, its checksum and its shared-library listing. The emulator uses the same pinned AWS base image. Package format tests use synthetic ELF headers and prove packaging behavior only; the emulator is the execution check for the real binary. The tests use Node to collect every route, instance mode and outbound policy requested by the shared cases, then require a matching extracted package and manifest. Go echo must have both reused and per-request archives.

`check-runtime.mjs` exercises the real SDK through a local Runtime API fixture. `check-rie.mjs` runs the shared guest/HTTP cases through AWS's emulator. Shutdown cancellation, invalid startup manifests and rejected acknowledgements remain additional protocol-fixture checks. Neither harness measures cold start or throughput. Failed runs write their result reports and container logs; CI retains the packages and results for seven days. Test-created containers are removed by their exact IDs, and test servers are closed. Local output directories belong to the caller; retain them until the results are reviewed.

No AWS credentials are used. Emulator success is not a deployment claim: provider wire behavior, deadlines/resource limits, initialization error reporting, arm64, production integration, packed public packages, and matched provider performance remain separate requirements.

## Vercel executable function

The same crate builds `polyroute-vercel` for [ADR 0018](../../docs/decisions/0018-vercel-executable-function.md). It serves one route through Vercel's official `vercel_runtime` bridge instead of the Lambda Runtime API. Both binaries include the same `core.rs`, `route.rs` and `outbound.rs`, so worker reuse, Go's replacement limit, trap retirement, the outbound policy and response validation are shared. Vercel starts the executable with no arguments, so it reads `manifest.json` from its own directory. A trap or invalid response returns a plain `500 Internal Server Error` and writes the cause to stderr.

Before it reports readiness, the host reads its own executable and the component once, start to finish, and creates the instance the first request will use ([ADR 0021](../../docs/decisions/0021-prepare-vercel-routes-before-readiness.md)). Vercel usually starts a function seconds before its first request and freezes it after readiness, so this takes guest startup and file system reads off that request. An instance started for a waiting request pays for the reads on that request instead. If the instance can't be created, the host exits before readiness. A component path ending in `.zst` is decompressed into memory first; the zstd frame must record its decompressed size, as the `zstd` command and `build-vercel-output.mjs` write it. Set `"serverTiming": true` in `manifest.json` to add a `Server-Timing` header with each phase in milliseconds. The first response reports `prefetch`, `load`, `prepare` and `wait` (from readiness until that request arrived). Every response reports `call`, plus `instantiate` when that request had to create an instance. It is off by default.

After the Docker build above:

```sh
node probes/lambda/check-vercel.mjs --fixtures /tmp/lambda-fixtures/fixtures.json \
  --binary /tmp/lambda-host/polyroute-vercel --output /tmp/vercel-protocol
node probes/lambda/prepare.mjs --set benchmark --output /tmp/vercel-fixtures
node probes/lambda/build-vercel-output.mjs --host /tmp/lambda-host/polyroute-vercel \
  --fixtures /tmp/vercel-fixtures/fixtures.json --output /tmp/vercel/output
node probes/lambda/check-vercel-output.mjs --output /tmp/vercel/output
```

`check-vercel.mjs` runs the shared guest cases over HTTP, with a local unix socket standing in for Vercel's IPC bridge. It requires one `server-started` message before any request and one `end` message per request. HTTP headers are bytes, so the case that sends a character above U+00FF is reported as skipped, not passed.

`build-vercel-output.mjs` writes a Build Output v3 directory, creating missing parent directories while refusing an existing output directory. Each benchmark route appears twice: as a native `executable` function (`/api/primes`, `/api/slug`, `/api/stats`) and as its TypeScript twin on Node 24 (`/api/primes-ts`, and so on). Each native function ships its component compressed with zstd level 19 as `route.cwasm.zst` ([ADR 0022](../../docs/decisions/0022-compress-vercel-components.md)), which needs Node 22.15 or later. `/api/warmup` and `/api/load` serve the measurement harnesses below. `check-vercel-output.mjs` starts each native function as Vercel does and requires the same body as its twin. It also requires `/_vercel/ping` to wait while a long primes call runs, so Vercel sends concurrent requests to another instance instead of queueing them ([ADR 0023](../../docs/decisions/0023-hold-vercel-pings-during-guest-calls.md)). Nothing here deploys; `vercel deploy --prebuilt` from the project directory containing `.vercel/output` needs a linked project and is a separate, explicit step.

Rebuild the addon and prepare fresh fixtures before packaging. [ADR 0019](../../docs/decisions/0019-native-cpu-baseline.md) changes compilation to the target's baseline CPU features after the first provider invocation rejected a component compiled for optional instructions on the CI machine. Existing host-tuned `.cwasm` files are not made portable by repackaging them. Local bridge checks do not establish CPU compatibility on the provider; require successful deployed native responses before timing.

### Measuring first requests

`measure-vercel-cold.mjs` deploys a Build Output again and again and times each function's first request against the same deployment's warm requests. Every request uses a fresh connection and curl's own timers, from TLS completion to the first response byte, and every body is checked. Most of a new deployment's first function requests pay an extra ~100 ms whatever the runtime, until the deployment has served several function requests; waiting doesn't help. Each round therefore sends `--warmup` requests (default 10) to `/api/warmup` before the measured ones. `--revisit` warms the path the same way, then sends one more request to every function of earlier deployments. Run it once they have been idle long enough for Vercel to stop their instances; in these runs, 45 minutes was enough.

```sh
node probes/lambda/measure-vercel-cold.mjs --deploy <linked directory> --scope <team> \
  --rounds 10 --output /tmp/vercel-first
node probes/lambda/measure-vercel-cold.mjs --deploy <linked directory> --scope <team> \
  --revisit /tmp/vercel-first/deployments.json --output /tmp/vercel-revisit
```

`--deploy` is the linked project directory holding `.vercel/output` and the `.vercel/output.files.json` that `build-vercel-output.mjs` writes; the harness refuses to deploy files that differ from it. `--functions` takes a JSON list of `{ name, path, body, method?, send? }` to measure other functions; their Build Output must also serve `/api/warmup`, or pass `--warmup 0`. Each round creates a preview deployment in the linked project, so run it only with the project owner's approval, and remove the previews afterward.

### Measuring requests per second

`measure-vercel-load.mjs` sends sustained load to the deployments `measure-vercel-cold.mjs` recorded, through `load-function.mjs`. For each deployment and each `--connections` count (default `1,10,50`), every function runs in turn: that many clients send requests back to back over kept-alive connections for `--warmup` seconds (default 2), then for `--duration` seconds (default 8), and only the requests that finish inside the measured window count. The order rotates with each deployment and reverses at every other connection count. `/api/warmup` runs first and last at each count as an A/A control. Every 200 response's body is checked. A 429 or 5xx response is counted as an error and reported, and any other status or a wrong body stops the run. A request that gets no response at all aborts that run, which is recorded and runs again, up to three times.

```sh
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> node probes/lambda/measure-vercel-load.mjs \
  --deployments /tmp/vercel-first/deployments.json --from vercel --output /tmp/vercel-load
```

By default the load comes from this client, so its round trip is part of every request and requests per second mostly follow latency; a home network may also refuse bursts of new connections. `--from vercel` instead posts each run to the deployment's `/api/load` function, which runs the same code inside the deployment's region and returns the result, including its own CPU use as `generatorCpu`. Near 1, the generator rather than the function limited the rate.

Preview deployments are protected, so set `VERCEL_AUTOMATION_BYPASS_SECRET` to the project's Protection Bypass for Automation secret. The harness sends it as `x-vercel-protection-bypass` and never writes it out. `/api/load` reads the same secret from the system environment variable Vercel exposes to the deployment and answers 403 unless the request repeats it in `x-polyroute-load-secret`, so a deployment without protection can't be made to load itself. It only targets paths under `/api/` on its own host, with at most 200 connections and 60 seconds per run. Native functions built with `serverTiming` add their guest time and the `wait` of each instance's first response, which counts the instances Vercel started during the load. Run it before `--revisit`, and wait for the deployments to go idle afterward. [The languages record](../../docs/benchmarks/2026-11-21-vercel-languages.md) has measured results from both modes.
