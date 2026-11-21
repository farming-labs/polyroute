# Vercel first requests: native routes against TypeScript

**Preparing the guest before readiness removes the native first-request penalty on Vercel's pre-started instances.** On instances Vercel starts ahead of the request, native first requests now beat their TypeScript twins. Instances started for a waiting request still pay the startup read on that request; the on-demand section below has the measured cost. This is first-request latency only. Warm throughput on the provider was not measured, and from this client the warm requests are network-bound.

## Setup

- **Project:** farming-labs `polyroute-native-probe`, protected previews, Vercel's default region. Requests go through `vercel curl` (CLI 48.8.2), which adds the protection bypass.
- **Client:** macOS 25.2.0 on Apple M1 with curl 8.7.1 and Node 24.21.0, on a residential connection. The client was shared with other builds, so client load varied.
- **Timing:** curl's own timers, from TLS completion to the first response byte. Each request uses a fresh connection, and every response must be HTTP 200 with the exact expected body.
- **Functions:**
  - Rust primes below 10,000 (`/api/primes`), the Go slug of `hello` (`/api/slug`), and Python statistics for `[1, 2, 3, 4]` (`/api/stats`).
  - The TypeScript twins run the same algorithms on Node 24 (`/api/primes-ts`, `/api/slug-ts`, `/api/stats-ts`).
- **Artifacts:** components and twins come from CI artifact `14470416952`, built at `7e4ce3d` and verified file by file against its manifest before each deployment. The experiment hosts are local cross-builds (`cargo zigbuild`, target `x86_64-unknown-linux-gnu.2.34`) of this branch. Each adds a temporary manifest knob that selects the startup behavior, so every variant runs in one deployment:
  - Five-variant host: SHA-256 `149638207b690a23b5441d1bc01ba9952ba366d1aafb51724f04f12bf6402333`.
  - `fadvise` host: SHA-256 `44e6da34b9bc7e491e9e05f578a2b68f7b61dade230416ad0882c404b53934a1`.
- **Metrics:**
  - The _first request_ is each function's first request on a fresh preview deployment.
  - _Excess_ is that request minus the median of the same function's warm requests on the same deployment. It removes most of the round trip.
  - _Guest time_ is the host's own report of the time it spent instantiating and calling the guest during that request.

## What was wrong

Six fresh previews of the CI-built host, which instantiates lazily:

| Function | Native first median (ms) | TypeScript first median (ms) | Paired native − TypeScript median (ms) |
| -------- | -----------------------: | ---------------------------: | -------------------------------------: |
| Rust     |                      239 |                          245 |                                     −5 |
| Go       |                      316 |                          225 |                                    +86 |
| Python   |                      276 |                          185 |                                    +90 |

**Size didn't matter.** One deployment added two padded copies of the Rust function. Their extra files matched the Go and Python components' extra raw bytes (14.3 MB, 31.3 MB) and zstd-compressed bytes (4.4 MB, 10.6 MB). Over six first-request phases, neither copy was slower than the unpadded function within either latency mode (described below):

| Function                   | Fast-mode first requests (ms) | Slow-mode first requests (ms) |
| -------------------------- | ----------------------------- | ----------------------------- |
| Rust, unpadded             | 145–151                       | 227–249                       |
| Rust, Go-sized padding     | 136–143                       | 233–251                       |
| Rust, Python-sized padding | 126–132                       | 175–251                       |

Even in their last positions, Go and Python first requests stayed about 80 and 130 ms above unpadded Rust's fast mode. Their extra cost comes from the bytes the guest reads, not the bytes deployed.

**Server-Timing showed where the time went.** Every first request reached an instance Vercel had started 3–26 seconds earlier. The host spent that request instantiating the guest and faulting the component's pages in from the function's file system: Go instantiation took about 85 ms and Python's first call about 141 ms. A host that did the same work on a background thread after readiness made no progress until the request arrived, because Vercel freezes the instance in between.

## Startup variants

Every variant ran in the same deployments, with the TypeScript twins alongside: eight fresh previews in one run, plus six more for `fadvise` with the checked-in harness. Guest time is the median on the first request; every one of these instances was pre-started.

| Variant                                        | Rust guest (ms) | Go guest (ms) | Python guest (ms) | Read before readiness, Rust / Go / Python (ms) |
| ---------------------------------------------- | --------------: | ------------: | ----------------: | ---------------------------------------------: |
| Lazy (the host before this change)             |            18.7 |         103.0 |             148.5 |                                              — |
| Instantiate before readiness                   |            10.6 |          20.5 |             144.3 |                                              — |
| Read component, instantiate                    |             9.1 |           7.0 |               8.9 |                                9.7 / 121 / 256 |
| **Read executable and component, instantiate** |         **0.7** |       **1.4** |           **4.3** |                             **70 / 178 / 318** |
| Same, eight parallel readers                   |             0.7 |           1.1 |               3.5 |                              152 / 549 / 1,003 |
| `posix_fadvise(WILLNEED)` both, instantiate    |            16.9 |          25.8 |             143.0 |                                   10 / 16 / 16 |

The host now uses the bold row. Parallel readers barely help the request and take three times as long to read, and `fadvise` doesn't help at all.

## First requests on pre-started instances

For about 15 seconds after a deploy, most first requests pay an extra ~100 ms, whatever the runtime. That held for 38 of 46 requests in the first four positions after the deploy and 2 of 76 from the ninth position on. The eight- and six-round runs listed the TypeScript twins last, so they always arrived after that window while native functions often didn't. This table therefore compares only requests from the ninth position on. The checked-in harness now waits 30 seconds after each deploy instead.

| Function | Prepared native: n / first median / excess median (ms) | Lazy native: n / excess median (ms) | TypeScript twin: n / first median / excess median (ms) |
| -------- | -----------------------------------------------------: | ----------------------------------: | -----------------------------------------------------: |
| Rust     |                                           8 / 109 / −7 |                             11 / 22 |                                          10 / 132 / 20 |
| Go       |                                            2 / 116 / 1 |                             4 / 101 |                                          11 / 122 / 11 |
| Python   |                                            6 / 124 / 4 |                             3 / 152 |                                          12 / 128 / 18 |

Prepared native first requests beat their twins' excess by 12–27 ms. The Go row has only two settled samples; the server-reported guest time (1.4 ms in all fourteen previews) is the stronger evidence for Go. Across all positions, the prepared Rust, Go and Python medians were also below TypeScript's within each latency mode.

## On-demand instances

Pending: the `--revisit` pass over the fourteen deployments after 45 idle minutes.

## Raw data

Sample files are kept outside the repository. Their SHA-256 digests:

- Lazy baseline, six rounds: `33b3520e9bec55d97e0f40724b1f304e85029917d356b48b32016e5e7697d301`.
- Size isolation, five complete rounds plus one first-request phase: `f082f638aef5156900181e90b07746df22499a22da01733fc34e85afad749a5e`.
- Five startup variants, eight rounds: `403e2f03580721a441a6cafce5d1b0021fb1363b090ce69a2a02207831d0a9be`.
- `fadvise`, six rounds with `measure-vercel-cold.mjs`: `7edcce52d41a09cbf9b1ca01d910ca027f1204e9f066c97043ad790a792c05be`.

## Limits

- This is one region, one client and one project, with 6–14 previews per comparison.
- The experiment hosts are local cross-builds, not the CI artifact.
- Client load varied, and the round trip from this client (~110 ms) dominates every warm request, so these runs can't compare warm throughput.
- Server-Timing comes from the native host only; the TypeScript twins report nothing about their own startup.
