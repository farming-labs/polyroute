# Native runtime measurements after Python transfer batching, 2026-11-18

The current addon still fails the complete throughput gate and the broader TypeScript goal. The Linux relay loses to jco at one connection, and Go and Python trail matched TypeScript at both connection counts on both runners. The standalone-host experiment is separate from these results.

## Source and protocol

Source: `4449e37726a573a234daa11eeeefa3fe7bb92a61`, [CI run 44319402846](https://github.com/farming-labs/polyroute/actions/runs/44319402846). This includes the compiler-free runtime and private Python transfer interface. All nine workflow jobs succeeded, including both runtimes’ production and packed checks. The 18 benchmark reports are retained in:

- `matched-benchmarks-Linux-X64`, artifact `14439267904`.
- `matched-benchmarks-macOS-ARM64`, artifact `14438653284`.

Each artifact records its source commit, environment, all rounds and cold samples, p95, and errors. They have the workflow’s 30-day retention. A local validation recalculated every median and p95, checked the route/build identities and round counts, and confirmed 1,560 measured warm rounds plus 3,120 cold samples. Warmups and measurements reported zero response errors; no samples were discarded. Cold responses were checked for status and exact body before accepting each sample.

Warm protocol: five alternating rounds, one-second warmups, three-second samples, one and ten connections, plus both A/A controls. Cold protocol: twenty fresh processes per route/build; timing ends at the first correct response, before shutdown. The cold report’s unused connection-count field does not create concurrent cold requests. Both runtimes run the same algorithms and payloads, and the outbound relay remains included.

Do not infer a before/after optimization gain by comparing this run with the [earlier report](2026-11-18-native-runtime.md). The Linux CPU model changed, and the macOS Node patch version and machine load differ. Every comparison below stays within this run and platform.

## Linux-X64

AMD EPYC 9V74 80-Core Processor, 4 logical CPUs, linux 7.0.0-1019-azure, Node 24.22.2.

### 1 connection

| Workload                          | Native req/s | TypeScript req/s | jco req/s | Native / TypeScript | Native / jco | p95 native / TypeScript / jco (ms) |
| --------------------------------- | -----------: | ---------------: | --------: | ------------------: | -----------: | ---------------------------------: |
| Rust (little work)                |        3,651 |            5,193 |     3,632 |              0.703× |       1.005× |              0.313 / 0.233 / 0.329 |
| Rust (primes to 10,000)           |        2,109 |            2,404 |     2,083 |              0.877× |       1.012× |              0.514 / 0.451 / 0.518 |
| Rust (primes to 100,000)          |          194 |              194 |       195 |              1.001× |       0.997× |              5.277 / 5.294 / 5.305 |
| Rust relay (one outbound request) |        1,373 |            2,711 |     1,663 |              0.507× |       0.826× |              0.771 / 0.415 / 0.687 |
| Go                                |        2,507 |            5,139 |     2,350 |              0.488× |       1.067× |              0.448 / 0.236 / 0.491 |
| Python                            |        2,273 |            3,670 |     1,801 |              0.619× |       1.262× |              0.477 / 0.310 / 0.614 |

### 10 connections

| Workload                          | Native req/s | TypeScript req/s | jco req/s | Native / TypeScript | Native / jco | p95 native / TypeScript / jco (ms) |
| --------------------------------- | -----------: | ---------------: | --------: | ------------------: | -----------: | ---------------------------------: |
| Rust (little work)                |        6,552 |           14,800 |     6,700 |              0.443× |       0.978× |              2.482 / 1.122 / 2.577 |
| Rust (primes to 10,000)           |        2,818 |            3,464 |     2,854 |              0.813× |       0.987× |              5.991 / 4.780 / 6.417 |
| Rust (primes to 100,000)          |          201 |              203 |       202 |              0.987× |       0.994× |           84.990 / 83.418 / 84.907 |
| Rust relay (one outbound request) |        2,477 |            4,924 |     1,682 |              0.503× |       1.472× |              4.947 / 2.614 / 8.968 |
| Go                                |        3,439 |           15,043 |     3,206 |              0.229× |       1.073× |              5.273 / 1.012 / 5.770 |
| Python                            |        3,648 |            8,998 |     2,487 |              0.405× |       1.467× |              4.576 / 1.743 / 7.430 |

### Cold process start

| Workload                          | Native median / p95 (ms) | TypeScript median / p95 (ms) | Median difference (ms) |
| --------------------------------- | -----------------------: | ---------------------------: | ---------------------: |
| Rust (little work)                |          62.701 / 66.809 |              59.100 / 65.672 |                 +3.601 |
| Rust (primes to 10,000)           |          62.791 / 66.374 |              60.707 / 66.741 |                 +2.084 |
| Rust (primes to 100,000)          |          67.474 / 70.738 |              66.046 / 69.152 |                 +1.427 |
| Rust relay (one outbound request) |          78.324 / 83.458 |              72.695 / 78.134 |                 +5.629 |
| Go                                |          65.086 / 68.831 |              59.175 / 62.944 |                 +5.911 |
| Python                            |          70.784 / 74.083 |              60.835 / 62.937 |                 +9.949 |

## macOS-ARM64

Apple M1 (Virtual), 3 logical CPUs, darwin 25.6.0, Node 24.22.3.

### 1 connection

| Workload                          | Native req/s | TypeScript req/s | jco req/s | Native / TypeScript | Native / jco | p95 native / TypeScript / jco (ms) |
| --------------------------------- | -----------: | ---------------: | --------: | ------------------: | -----------: | ---------------------------------: |
| Rust (little work)                |        2,489 |            3,280 |     2,576 |              0.759× |       0.966× |              0.935 / 0.651 / 0.958 |
| Rust (primes to 10,000)           |        1,533 |            1,380 |     1,517 |              1.111× |       1.011× |              1.496 / 1.498 / 1.635 |
| Rust (primes to 100,000)          |          163 |              133 |       200 |              1.226× |       0.817× |           10.746 / 11.530 / 10.155 |
| Rust relay (one outbound request) |          567 |            1,452 |       609 |              0.390× |       0.930× |              3.207 / 1.310 / 3.124 |
| Go                                |        1,642 |            3,089 |     1,379 |              0.531× |       1.190× |              1.510 / 0.676 / 1.721 |
| Python                            |        1,330 |            2,336 |       982 |              0.569× |       1.355× |              1.643 / 0.947 / 2.510 |

### 10 connections

| Workload                          | Native req/s | TypeScript req/s | jco req/s | Native / TypeScript | Native / jco | p95 native / TypeScript / jco (ms) |
| --------------------------------- | -----------: | ---------------: | --------: | ------------------: | -----------: | ---------------------------------: |
| Rust (little work)                |        9,346 |           13,282 |     6,998 |              0.704× |       1.336× |              2.233 / 1.751 / 3.207 |
| Rust (primes to 10,000)           |        3,746 |            3,275 |     4,699 |              1.144× |       0.797× |              5.091 / 5.386 / 3.847 |
| Rust (primes to 100,000)          |          242 |              191 |       317 |              1.264× |       0.764× |           74.276 / 93.442 / 56.711 |
| Rust relay (one outbound request) |        2,611 |            4,785 |     1,814 |              0.546× |       1.439× |             7.109 / 4.413 / 11.215 |
| Go                                |        3,995 |            9,849 |     3,346 |              0.406× |       1.194× |              5.408 / 2.260 / 7.139 |
| Python                            |        5,866 |            8,391 |     3,026 |              0.699× |       1.939× |              3.469 / 2.696 / 8.008 |

### Cold process start

| Workload                          | Native median / p95 (ms) | TypeScript median / p95 (ms) | Median difference (ms) |
| --------------------------------- | -----------------------: | ---------------------------: | ---------------------: |
| Rust (little work)                |         76.108 / 108.288 |             75.191 / 100.698 |                 +0.918 |
| Rust (primes to 10,000)           |         81.331 / 119.959 |              74.710 / 90.838 |                 +6.621 |
| Rust (primes to 100,000)          |         83.801 / 101.364 |             79.735 / 100.367 |                 +4.067 |
| Rust relay (one outbound request) |         90.326 / 115.726 |             82.076 / 104.315 |                 +8.250 |
| Go                                |          78.658 / 95.558 |              71.282 / 88.300 |                 +7.375 |
| Python                            |         89.769 / 105.477 |              70.330 / 87.403 |                +19.439 |

## Controls and verdict

Linux’s native-versus-jco relay ratio is 0.826× at one connection. Its native A/A paired ratios for that workload span 0.965–0.998× and jco’s span 0.993–1.048×, so the loss exceeds the observed control variation. The 100,000-prime Rust result is effectively tied with TypeScript at one connection (1.001×); that is not a demonstrated win. Python beats jco in this run, but still reaches only 0.619× and 0.405× of matched TypeScript throughput.

macOS is noisy. Its one-connection A/B run began at load average 25.66 on three logical CPUs. Native A/A paired ratios span 0.693–1.254× at one connection and 0.464–1.355× at ten across the native workloads. Keep the losses and controls; do not turn small median differences into acceptance. In particular, compute-heavy Rust still loses to jco at ten connections, while Go and Python remain below TypeScript.

Every native cold median is higher than its matched TypeScript median, although several small differences fall within control variation. All remain within the RFC’s 30 ms allowance. Across native workloads, native cold A/A median differences range from −1.170 to +0.838 ms on Linux and −8.673 to +2.630 ms on macOS; jco’s range from −1.940 to +0.601 ms and −7.339 to +7.640 ms respectively. These controls do not establish a native cold-start advantage.

The addon does not meet every-language, both-connection throughput acceptance on either runner. Keep it experimental. Passing CI and the improved Python boundary do not justify merging it as a completed performance feature.

## Reproduction and limits

The workflow records the exact commands. `scripts/bench.mjs` uses `--matched --rounds 5 --duration 3 --warmup 1 --connections 1` and then `10`, with native/jco A/B and each runtime’s A/A. Cold commands use `--matched --cold --rounds 20` for all three pairs. The local `polyroute-native-bench-4449` directory preserves the downloaded ZIPs, raw reports, checksums, `validate.py`, `summarize.py`, and derived data.

These are process measurements on CI runners, not deployed serverless measurements. The standalone host, Go cleanup candidate, pin-lifetime hook, and response-writer fix are absent. No cross-run or cross-machine gain, provider cold start, or completed acceptance is claimed. The next mechanism under test is the [standalone host with pooled outbound HTTP](../decisions/0010-standalone-native-host.md).
