# Native Lambda verification probe

**Build and verify a private, compiler-free Lambda artifact from the standalone native prototype.**

This is an experiment for [ADR 0014](../../docs/decisions/0014-local-lambda-adapter.md) and [ADR 0015](../../docs/decisions/0015-linux-lambda-artifact.md). It does not add a public Polyroute deployment target, deploy resources, or establish provider performance. The Go SDK oversized-response bug remains unresolved. The initial Linux target is x86_64 only.

The adapter uses the official AWS Runtime API client and HTTP request parser. Its response encoder preserves exact bytes, Latin-1 headers, repeated ordinary headers, and cookies. Guest capabilities, Go's 1,000-request limit, and trap retirement match the tested standalone prototype. The Python resource implementation is imported directly from the production crate. `provenance.json` pins the production sources from which the isolated worker and policy contract were derived; preparing fixtures fails when those sources change, requiring review before updating that record.

On Linux with Docker, Node 24, pnpm, Rust with `wasm32-wasip2`, Go 1.27, and componentize-py 0.25.1:

```sh
pnpm install --frozen-lockfile
pnpm --filter @farming-labs/polyroute-wasmtime build
pnpm build
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

The Docker build pins the AWS Amazon Linux 2023 image digest and Rust 1.99.1. It verifies the Rust bootstrap checksum, runs formatting, Clippy and seven Rust tests, then builds with locked dependencies. The final export contains the host, its checksum and its shared-library listing. The emulator uses the same pinned AWS base image. Package format tests use synthetic ELF headers and prove packaging behavior only; the emulator is the execution check for the real binary.

`check-runtime.mjs` exercises the real SDK through a local Runtime API fixture. `check-rie.mjs` runs the same twenty guest/HTTP groups through AWS's emulator. Shutdown cancellation, invalid startup manifests and rejected acknowledgements remain additional protocol-fixture checks. Neither harness measures cold start or throughput. Failed runs write their result reports and container logs; CI retains the packages and results for seven days. Test-created containers are removed by their exact IDs, and test servers are closed. Local output directories belong to the caller; retain them until the results are reviewed.

No AWS credentials are used. Emulator success is not a deployment claim: provider wire behavior, deadlines/resource limits, initialization error reporting, arm64, production integration, packed public packages, and matched provider performance remain separate requirements.
