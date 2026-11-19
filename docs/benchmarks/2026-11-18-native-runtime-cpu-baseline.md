# Current native runtime: local startup improvement

The CPU-baseline build demonstrates an incremental local startup improvement over the default jco build. Rust computation, Go and Python reductions exceed every observed same-workload A/A paired difference. The outbound relay median also falls, but its control variation is wider than the effect. This supports an opt-in experimental increment; it does not establish provider cold starts, improved throughput, or the complete TypeScript goal.

## Source and protocol

Both production artifacts come from commit `7e4ce3d68a3f8f8f23f512c6426e10aad301cb3c`, [CI run 44428563548](https://github.com/farming-labs/polyroute/actions/runs/44428563548). The downloaded ZIP digests were checked against GitHub, and every extracted file was hashed before measurement and rechecked afterward. Both archives were built by the same macOS Node 24 CI job.

- Default jco: artifact `14486131552`, ZIP SHA-256 `7997009ef6f8649fb9d8efc4190f835102db0deb11e1be805fe298897179fa1f`.
- Native: artifact `14485991740`, ZIP SHA-256 `7ee93d64e0ff2fcaad10d1b0e4f5164147be91ebded45d99acb346f0548074c6`.

The local measurement used Apple M1, eight logical CPUs, macOS kernel 25.2.0 and Node 24.21.0. All thirteen routes ran, including the matched TypeScript twins and outbound relay. Each sample starts a fresh Node process and ends at the first fully read, correct HTTP response; shutdown is excluded. There is no application warmup for this cold-process protocol. Twenty rounds reverse both route and build order. Separate A/A runs put the native build, then the jco build, on both sides. All three reports contain the expected 520 samples: 1,560 total, zero response errors and no discarded samples.

The one-minute machine load varied during the run: A/B 7.10 → 6.86, native A/A 6.86 → 6.51, and jco A/A 6.51 → 8.72. These are not dedicated-runner measurements. The conservative control check below compares each A/B median reduction with the largest absolute paired difference observed in either A/A run for that same workload. It describes observed noise, not a statistical confidence interval.

## Complete results

For TypeScript rows, the native column means the TypeScript route served from the app built with the native option. TypeScript itself is not compiled by Wasmtime.

| Route                                   | Default jco median / p95 (ms) | Native app median / p95 (ms) | Median reduction | Largest A/A paired difference (ms) | Exceeds observed control range |
| --------------------------------------- | ----------------------------: | ---------------------------: | ---------------: | ---------------------------------: | ------------------------------ |
| TypeScript                              |               76.163 / 91.471 |              52.655 / 58.427 |            30.9% |                             22.134 | Yes                            |
| Rust (little work)                      |               84.583 / 99.601 |              54.214 / 62.441 |            35.9% |                             20.185 | Yes                            |
| TypeScript (little work)                |               74.028 / 77.970 |              51.593 / 54.749 |            30.3% |                             20.036 | Yes                            |
| Rust (primes to 10,000)                 |               82.844 / 91.647 |              54.844 / 71.205 |            33.8% |                             27.584 | Yes                            |
| TypeScript (primes to 10,000)           |               73.039 / 80.170 |              51.493 / 56.232 |            29.5% |                             16.573 | Yes                            |
| Rust (primes to 100,000)                |               85.785 / 90.909 |              56.257 / 59.848 |            34.4% |                             15.713 | Yes                            |
| TypeScript (primes to 100,000)          |               77.394 / 82.158 |              55.861 / 58.293 |            27.8% |                             27.740 | No                             |
| Rust relay (one outbound request)       |              96.809 / 104.580 |              62.372 / 66.486 |            35.6% |                             39.491 | No                             |
| TypeScript relay (one outbound request) |               80.407 / 84.000 |              58.058 / 62.301 |            27.8% |                            100.254 | No                             |
| Go                                      |             114.517 / 121.561 |              56.946 / 60.144 |            50.3% |                             20.871 | Yes                            |
| TypeScript (slug)                       |               72.627 / 76.434 |              51.484 / 58.717 |            29.1% |                              6.543 | Yes                            |
| Python                                  |             117.410 / 132.079 |              61.321 / 90.326 |            47.8% |                              5.472 | Yes                            |
| TypeScript (stats)                      |               72.818 / 80.198 |              52.162 / 58.797 |            28.4% |                              9.572 | Yes                            |

Rust computation startup medians fall by 33.8–35.9%, Go by 50.3%, and Python by 47.8% relative to jco. The relay and two TypeScript rows overlap the observed control range; their lower medians are retained without treating them as established improvements. Native guest cold medians remain above their matched TypeScript routes in the native app. No new warm-throughput comparison was run.

## Size and compatibility

The complete default deployment is 29,037,789 bytes across 30 files; the native deployment is 52,780,900 bytes across 7 files. The native option therefore increases this app's artifact size, even though its deployment addon contains no compiler. These byte counts describe the extracted artifacts, not a provider size-limit test.

The same source revision passes all ten CI checks, including Linux/macOS/Windows on Node 22/24, both Rust feature sets and the private Linux probe. Its CPU-baseline Vercel preview passes six basic provider response checks, as recorded in ADR 0019. These are independent correctness checks, not provider timing evidence. The default runtime and development path remain jco; native execution requires an explicit experimental option.

## Reproduction

Use Node 24.21.0, extract the two named CI artifacts into separate directories, then run the checked-in harness without rebuilding them:

```sh
node scripts/bench.mjs --server <native>/server.js --baseline <jco>/server.js --matched --cold --rounds 20 --json > cold-ab.json
node scripts/bench.mjs --server <native>/server.js --baseline <native>/server.js --matched --cold --rounds 20 --json > cold-aa-native.json
node scripts/bench.mjs --server <jco>/server.js --baseline <jco>/server.js --matched --cold --rounds 20 --json > cold-aa-jco.json
```

Raw report SHA-256 digests:

- `cold-ab.json`: `290752abc7a1fb390545886ae04f274ab7710ba1e53d79f00abd48fbcb3eabc6`.
- `cold-aa-native.json`: `7f3cfc6019f2ea863e8e43d68994d2b251476ccfeaafba08fd6bb459bfd9c78e`.
- `cold-aa-jco.json`: `3c50f8c95968a5175760c2e1d61d8db61f505ab69dd0410684fc5b3a4b51a378`.

Keep this comparison separate from the earlier host-tuned measurements. The earlier throughput losses and Go SDK response-write limitation are not resolved by these startup results. The full throughput and serverless goals remain requirements for graduating the runtime and completing the broader work.
