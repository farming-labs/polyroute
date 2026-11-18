# Native runtime measurements, 2026-11-18

The prototype does not meet the throughput acceptance in [RFC 0001](../rfcs/0001-native-runtime.md). It also does not meet the broader goal of beating matched TypeScript on every workload. Integration checks passing is a separate result.

## CI comparison

Source: `7daf491` in [run 44295985292](https://github.com/farming-labs/polyroute/actions/runs/44295985292). The run succeeded, including both runtimes’ production and packed checks. Its two benchmark artifacts contain every A/B and A/A round, cold sample, p95, environment, and source commit:

- `matched-benchmarks-Linux-X64`, artifact `14427912314`.
- `matched-benchmarks-macOS-ARM64`, artifact `14426524902`.

These artifacts have the workflow’s 30-day retention. Results below come from that run only; they do not include later compiler separation or the Go pin-lifetime experiment.

Warm protocol: five alternating rounds, one second of warmup and three seconds of measurement per route/build, at one and ten connections. Cold protocol: twenty fresh-process samples per route/build, stopping the timer at the first correct response. All warm response checks passed and no rounds were discarded. A/A comparisons repeated each runtime against itself. The outbound relay is included.

Each table shows median native / matched TypeScript / jco requests per second. Parentheses give native divided by TypeScript and native divided by jco; higher is better.

### macOS-ARM64

Apple M1 (Virtual), 3 logical CPUs, darwin 25.6.0, Node 24.22.2.

| Workload                          |                         1 connection |                          10 connections |
| --------------------------------- | -----------------------------------: | --------------------------------------: |
| Rust (little work)                | 3,088 / 4,502 / 2,629 (0.69×, 1.17×) | 12,041 / 13,255 / 10,913 (0.91×, 1.10×) |
| Rust (primes to 10,000)           | 1,838 / 1,541 / 1,837 (1.19×, 1.00×) |    3,904 / 3,223 / 4,681 (1.21×, 0.83×) |
| Rust (primes to 100,000)          |       181 / 131 / 231 (1.39×, 0.78×) |          260 / 205 / 342 (1.27×, 0.76×) |
| Rust relay (one outbound request) |     785 / 1,660 / 781 (0.47×, 1.01×) |    2,259 / 5,046 / 1,978 (0.45×, 1.14×) |
| Go                                | 1,952 / 3,888 / 1,562 (0.50×, 1.25×) |   5,421 / 16,991 / 4,561 (0.32×, 1.19×) |
| Python                            | 1,352 / 3,157 / 1,081 (0.43×, 1.25×) |    3,923 / 8,934 / 4,256 (0.44×, 0.92×) |

| Workload                          | Native cold median / p95 (ms) | Matched TypeScript cold median / p95 (ms) | Median difference (ms) |
| --------------------------------- | ----------------------------: | ----------------------------------------: | ---------------------: |
| Rust (little work)                |                70.57 / 101.44 |                             65.30 / 97.27 |                  +5.27 |
| Rust (primes to 10,000)           |                 72.13 / 93.81 |                             65.83 / 99.97 |                  +6.29 |
| Rust (primes to 100,000)          |                 76.64 / 99.01 |                            68.82 / 102.76 |                  +7.81 |
| Rust relay (one outbound request) |                80.47 / 121.04 |                            70.49 / 107.68 |                  +9.98 |
| Go                                |                69.45 / 104.76 |                             65.48 / 79.50 |                  +3.97 |
| Python                            |                76.79 / 112.04 |                             66.55 / 86.63 |                 +10.24 |

### Linux-X64

AMD EPYC 7763 64-Core Processor, 4 logical CPUs, linux 7.0.0-1019-azure, Node 24.22.2.

| Workload                          |                         1 connection |                       10 connections |
| --------------------------------- | -----------------------------------: | -----------------------------------: |
| Rust (little work)                | 2,894 / 3,820 / 2,908 (0.76×, 1.00×) | 4,970 / 9,460 / 4,912 (0.53×, 1.01×) |
| Rust (primes to 10,000)           | 1,691 / 1,947 / 1,688 (0.87×, 1.00×) | 2,255 / 2,799 / 2,254 (0.81×, 1.00×) |
| Rust (primes to 100,000)          |       174 / 177 / 173 (0.98×, 1.00×) |       179 / 180 / 178 (0.99×, 1.00×) |
| Rust relay (one outbound request) | 1,042 / 2,031 / 1,306 (0.51×, 0.80×) | 1,823 / 3,068 / 1,461 (0.59×, 1.25×) |
| Go                                | 2,035 / 3,768 / 1,886 (0.54×, 1.08×) | 2,802 / 9,514 / 2,520 (0.29×, 1.11×) |
| Python                            | 1,476 / 2,790 / 1,394 (0.53×, 1.06×) | 2,163 / 5,406 / 1,884 (0.40×, 1.15×) |

| Workload                          | Native cold median / p95 (ms) | Matched TypeScript cold median / p95 (ms) | Median difference (ms) |
| --------------------------------- | ----------------------------: | ----------------------------------------: | ---------------------: |
| Rust (little work)                |                 77.25 / 82.09 |                             72.71 / 77.93 |                  +4.53 |
| Rust (primes to 10,000)           |                 77.48 / 81.22 |                             73.98 / 78.98 |                  +3.51 |
| Rust (primes to 100,000)          |                 82.80 / 87.48 |                             78.38 / 80.75 |                  +4.42 |
| Rust relay (one outbound request) |                97.85 / 100.31 |                             90.75 / 94.31 |                  +7.10 |
| Go                                |                 80.77 / 82.49 |                             71.72 / 75.21 |                  +9.05 |
| Python                            |                 85.35 / 91.10 |                             73.74 / 76.40 |                 +11.60 |

Native cold medians are within the RFC’s 30 ms allowance in both environments. They remain slower than their matched TypeScript routes. These are local process measurements on CI runners, not provider cold starts.

The macOS A/A controls show substantial noise: paired native round ratios span 0.83–1.47 across the one-connection workloads. Do not treat small differences as wins. Linux A/A variation is smaller, but the native relay loses to jco at one connection and every native workload loses to TypeScript in this run. Neither environment establishes the complete throughput gate.

## Reproduction

Build both variants from the same source and preserve their complete output directories. The CI workflow records the full sequence. For each connection count, it runs:

```sh
node scripts/bench.mjs --no-build --matched --json --rounds 5 --duration 3 --warmup 1 --connections 1 --baseline <jco/server.js> --server <native/server.js>
node scripts/bench.mjs --no-build --matched --json --rounds 5 --duration 3 --warmup 1 --connections 1 --baseline <native/server.js> --server <native/server.js>
node scripts/bench.mjs --no-build --matched --json --rounds 5 --duration 3 --warmup 1 --connections 1 --baseline <jco/server.js> --server <jco/server.js>
```

Repeat all three with `--connections 10`. Cold comparisons use `--cold --rounds 20` for A/B and both A/A pairs. Preserve JSON output rather than combining measurements from different runs.

## Standalone-host diagnostic

A separate local diagnostic ran Wasmtime CLI 50.0.2 without Node around the guest. It completed twenty cold A/B samples and both cold A/A controls, but its warm comparison failed on the Rust outbound relay with a 502 and `address not available`. The failed run and partial samples were preserved. They are not acceptance evidence.

The CLI’s default outbound implementation calls `TcpStream::connect` and creates an HTTP/1 connection for each request; it does not reuse a connection pool. That mechanism is consistent with address exhaustion under the relay load. The diagnostic also needs different Wasmtime concurrency settings and has not established the production host’s capability parity. It cannot be substituted for the addon’s production results.

## Remaining evidence

- Repeat acceptance against the final implementation; this run predates the compiler-free runtime.
- Retain the local compiler split’s initial 3.5% Rust 10,000-prime loss and its inconclusive focused repeat separately. Neither establishes a consistent throughput effect. See [ADR 0005](../decisions/0005-compiler-free-native-runtime.md).
- Keep the [Go pin-lifetime hook](../decisions/0006-go-request-pin-lifetime.md) experimental until its lifecycle and performance checks finish.
- Verify on the selected serverless provider. No provider deployment or performance result is claimed.
