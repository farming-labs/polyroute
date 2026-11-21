# Vercel first requests: native routes against TypeScript

**On instances Vercel starts ahead of a request, native first requests now beat their TypeScript twins.** The host reads its own executable and the component and creates the guest instance before it reports readiness, so the first request no longer pays for guest startup. **On instances started for a waiting request, only Rust wins.** Go loses by about 36 ms and Python by about 250 ms. This covers first-request latency only. Warm throughput on the provider wasn't measured, and from this client warm requests are bound by the network.

## Setup

- **Project:** farming-labs `polyroute-native-probe`, protected previews, Vercel's default region (`iad1`), reached through the `sfo1` edge. Requests go through `vercel curl` (CLI 48.8.2), which adds the protection bypass.
- **Client:** macOS 25.2.0 on Apple M1 with curl 8.7.1 and Node 24.21.0, on a residential connection. The client was shared with other builds, so client load varied.
- **Timing:** curl's own timers, from TLS completion to the first response byte. Each request uses a fresh connection, and every response must be HTTP 200 with the exact expected body.
- **Functions:**
  - Rust primes below 10,000 (`/api/primes`), the Go slug of `hello` (`/api/slug`), and Python statistics for `[1, 2, 3, 4]` (`/api/stats`).
  - The TypeScript twins run the same algorithms on Node 24 (`/api/primes-ts`, `/api/slug-ts`, `/api/stats-ts`).
- **Artifacts:** every run deploys components and twins built by CI, verified file by file against CI's manifest before each deployment. The native manifests add `serverTiming`.
  - Lazy baseline: the host from CI artifact `14470416952`, built at `7e4ce3d`.
  - Executable-and-component host: CI artifact `14693247977`, built at `a71fae8` (SHA-256 `b9d9860c6348de04064d81627769f4f59e9a60bdf0a82b1d5fd177e417e1f171`).
  - Component-only host: CI artifact `14696012392`, built at `403a590` (SHA-256 `e6b135254e24b9136ce016bf3fe95d342e59606975a514a4f872e2aafab53022`).
  - Experiment hosts: local cross-builds (`cargo zigbuild`, target `x86_64-unknown-linux-gnu.2.34`) of this branch. Each adds a temporary manifest knob that selects the startup behavior, so every variant runs in one deployment. Their SHA-256 digests: five variants `149638207b690a23b5441d1bc01ba9952ba366d1aafb51724f04f12bf6402333`, `fadvise` `44e6da34b9bc7e491e9e05f578a2b68f7b61dade230416ad0882c404b53934a1`, sections `ebf06e8f926ab32a3ad99b1515f4874dfa219d7dc8bbf4a4573e144ab15ef38b`.
- **Metrics:**
  - The _first request_ is each function's first request on a fresh preview deployment.
  - _Excess_ is that request minus the median of the same function's warm requests on the same deployment. It removes most of the round trip.
  - _Guest time_ is the host's own report of the time it spent instantiating and calling the guest during that request.
  - An _on-demand_ request is a function's next request after 45 idle minutes, when Vercel has stopped its instances. The host's `wait` phase confirms which kind of instance a request met: seconds for a pre-started one, under 10 ms for one started on demand.

## What was wrong

Six fresh previews of the lazy baseline host:

| Function | Native first median (ms) | TypeScript first median (ms) | Paired native − TypeScript median (ms) |
| -------- | -----------------------: | ---------------------------: | -------------------------------------: |
| Rust     |                      239 |                          245 |                                     −5 |
| Go       |                      316 |                          225 |                                    +86 |
| Python   |                      276 |                          185 |                                    +90 |

**Size didn't matter on pre-started instances.** One deployment added two padded copies of the Rust function. Their extra files matched the Go and Python components' extra raw bytes (14.3 MB, 31.3 MB) and zstd-compressed bytes (4.4 MB, 10.6 MB). Over six first-request phases, neither copy was slower than the unpadded function within either latency mode (described below):

| Function                   | Fast-mode first requests (ms) | Slow-mode first requests (ms) |
| -------------------------- | ----------------------------- | ----------------------------- |
| Rust, unpadded             | 145–151                       | 227–249                       |
| Rust, Go-sized padding     | 136–143                       | 233–251                       |
| Rust, Python-sized padding | 126–132                       | 175–251                       |

Even in their last positions, Go and Python first requests stayed about 80 and 130 ms above unpadded Rust's fast mode. Their extra cost comes from the bytes the guest reads, not the bytes deployed.

**Server-Timing showed where the time went.** Every first request reached an instance Vercel had started 3–26 seconds earlier. The host spent that request instantiating the guest and faulting the component's pages in from the function's file system: Go instantiation took about 85 ms and Python's first call about 141 ms. A host that did the same work on a background thread after readiness made no progress until the request arrived, because Vercel freezes the instance in between.

## Startup variants

Guest time is the median on the first request. Every one of these instances was pre-started, so reads before readiness happened before the request arrived. Eight fresh previews ran five variants together, and six more ran `fadvise`:

| Variant                                                      | Rust guest (ms) | Go guest (ms) | Python guest (ms) | Read before readiness, Rust / Go / Python (ms) |
| ------------------------------------------------------------ | --------------: | ------------: | ----------------: | ---------------------------------------------: |
| Lazy (the host before this change)                           |            18.7 |         103.0 |             148.5 |                                              — |
| Instantiate before readiness                                 |            10.6 |          20.5 |             144.3 |                                              — |
| Read component, instantiate                                  |             9.1 |           7.0 |               8.9 |                                9.7 / 121 / 256 |
| **Read executable and component, instantiate (this change)** |         **0.7** |       **1.4** |           **4.3** |                             **70 / 178 / 318** |
| Same, eight parallel readers                                 |             0.7 |           1.1 |               3.5 |                              152 / 549 / 1,003 |
| `posix_fadvise(WILLNEED)` both, instantiate                  |            16.9 |          25.8 |             143.0 |                                   10 / 16 / 16 |

Seven more previews read only one section of the component. Neither section alone came close to the whole file on pre-started instances, and on demand, after 45 idle minutes, every read cost more than it saved:

| Read before readiness      | Go guest (ms) | Python guest (ms) | Read, Go / Python (ms) | On demand, Go / Python (ms) |
| -------------------------- | ------------: | ----------------: | ---------------------: | --------------------------: |
| Nothing (instantiate only) |          25.6 |             148.2 |                      — |                   576 / 753 |
| `.rodata.wasm`             |          23.0 |              74.8 |                22 / 92 |                   599 / 759 |
| `.text`                    |          15.9 |              89.1 |               73 / 115 |                   571 / 845 |
| Whole component            |          11.8 |              15.5 |              114 / 259 |                   633 / 862 |
| TypeScript twin            |             — |                 — |                      — |                   587 / 557 |

The on-demand column has seven samples per cell. One request in it reached a Go function four minutes early, when a full disk stopped the client; the instance that served the measured request still reported an on-demand start.

Reading the component alone leaves the host executable's pages to fault in during the first request, which was enough to tie TypeScript (next sections). Parallel readers take three times as long to read, and `fadvise` doesn't help at all.

## The edge's slow mode

Most of a new deployment's first function requests take an extra ~100 ms, whatever the runtime. The extra cost fades as the deployment serves function requests, not as time passes. Requests slower than 175 ms from TLS to first byte, by position after the deploy:

| Position | No wait (three runs) | 30 s wait | Ten `/api/warmup` requests first |
| -------- | -------------------: | --------: | -------------------------------: |
| 1        |                20/20 |     10/10 |                              0/5 |
| 2        |                17/20 |     10/10 |                              0/5 |
| 3        |                18/20 |      8/10 |                              0/5 |
| 4        |                15/20 |      5/10 |                              0/5 |
| 5        |                 9/20 |      3/10 |                              1/5 |
| 6        |                 9/20 |      1/10 |                              0/5 |

A path no function serves doesn't help: the `sfo1` edge answers it without reaching `iad1`, as the `x-vercel-id` header shows. `/api/warmup` is a Node function only the harness calls, and requests to it warm the path for every other function. The checked-in harness now sends ten of them before each round's measured requests.

## First requests on pre-started instances

With the path warmed, the TypeScript twins' first requests took 12–24 ms more than their warm requests, so that is the margin native first requests have to beat. Reading only the component left about 11 ms of host page faults on the first request. On twelve previews of the component-only CI host, that tied:

| Function | Native first median (ms) | TypeScript first median (ms) | Paired native − TypeScript median (ms) | Native wins | Native guest time median (ms) |
| -------- | -----------------------: | ---------------------------: | -------------------------------------: | ----------: | ----------------------------: |
| Rust     |                      133 |                          133 |                                     −2 |        7/12 |                          10.7 |
| Go       |                      129 |                          131 |                                     −5 |        6/12 |                          11.4 |
| Python   |                      129 |                          124 |                                     −1 |        6/12 |                          11.4 |

Reading the executable as well took that off the request. Seven previews ran the executable-and-component host: five of CI artifact `14693247977` and two of CI artifact `14696144156`, built at `529a071` with a byte-identical host. Native first requests beat their twins' medians and won six of seven paired rounds per language:

| Function | Native first median (ms) | TypeScript first median (ms) | Paired native − TypeScript median (ms) | Native wins | Native guest time median (ms) |
| -------- | -----------------------: | ---------------------------: | -------------------------------------: | ----------: | ----------------------------: |
| Rust     |                      126 |                          136 |                                    −13 |         6/7 |                           0.7 |
| Go       |                      119 |                          140 |                                    −23 |         6/7 |                           1.4 |
| Python   |                      121 |                          134 |                                    −17 |         6/7 |                           4.4 |

The run of `529a071` was meant to cover twelve previews. A full disk on the client stopped it during the third with curl exit 23, so only its two complete rounds count.

## On-demand instances

On-demand first requests, medians with sample counts. All runs sent the revisit after 45 idle minutes, and every native request reported `wait` under 10 ms:

| Startup behavior                                |    Rust (ms) |      Go (ms) |  Python (ms) |
| ----------------------------------------------- | -----------: | -----------: | -----------: |
| Lazy                                            |     448 (20) |     593 (20) |     725 (20) |
| Instantiate before readiness                    |      425 (8) |      596 (8) |      714 (8) |
| Read component                                  |      445 (8) |      589 (8) |      866 (8) |
| **Read executable and component (this change)** | **471 (24)** | **642 (24)** | **851 (24)** |
| TypeScript twin                                 |     596 (30) |     606 (30) |     602 (30) |

The executable-and-component row pools the cross-build (14 samples) with the CI-built host (10). On its own, the CI-built host measured 471, 654 and 872 ms against its twins' 602, 611 and 607.

**Where an on-demand start goes.** For the CI-built host, the request took this much longer than the same deployment's warm requests (medians):

| Function | Bundle (MB) | Over warm (ms) | Host-reported (ms) | Remainder (ms) |
| -------- | ----------: | -------------: | -----------------: | -------------: |
| Rust     |        11.2 |            361 |                 69 |            291 |
| Go       |        25.5 |            543 |                179 |            358 |
| Python   |        42.5 |            759 |                326 |            436 |
| TS twins |   under 0.1 |        488–500 |                  — |              — |

Host-reported time is the read, load, preparation and the call; the remainder is the platform's start before the host runs, plus process start. It grows with the bundle, about 4.7 ms per MB here. The padded Rust copies measured less, 1.7–2.4 ms per MB (482 and 502 ms against 448). On pre-started instances, the platform pays that before the request; on demand, the request pays it. Python's on-demand start therefore needs fewer bytes, both deployed and read, not a better read order.

## Raw data

Sample files are kept outside the repository. Their SHA-256 digests:

- Lazy baseline, six rounds: `33b3520e9bec55d97e0f40724b1f304e85029917d356b48b32016e5e7697d301`.
- Size isolation, five complete rounds plus one first-request phase: `f082f638aef5156900181e90b07746df22499a22da01733fc34e85afad749a5e`; its revisit: `22650e7d3a6217e33a5fac58c3631e824c091dc5808b167567d36623669925ba`.
- Five startup variants, eight rounds: `403e2f03580721a441a6cafce5d1b0021fb1363b090ce69a2a02207831d0a9be`; its revisit: `f75ab72eb7b1fe918da03d9085f5538d6988a6a3de823ae9aec4d13c48eb4db0`.
- `fadvise`, six rounds: `7edcce52d41a09cbf9b1ca01d910ca027f1204e9f066c97043ad790a792c05be`; its revisit: `44dbb2f5dee2239c13241053cbc72f33ec8c86c24a20cc4a00c2f83ac26a431a`.
- Executable-and-component CI host, ten rounds with a 30-second wait: `fcec67f30bdfb1687877c8972676b3407506c57718c5a380e8821f858b8242e6`; its revisit: `e0dee1a13308942b32424ed586a78296c461cf8e351659ae02a75d4597e35e96`.
- The same host with the warmed path, five complete rounds: `23553bb2cc42a39247bae40f87a3c2afdd680617901e540c1536287e876db4cf`.
- The same host built at `529a071`, two complete rounds: `28b0c5d23d6179e3eef8df30d78bc633088f8725046b43c6ea724f9d0f4839f2`.
- Sections, seven rounds: `d91e9969d70a214b61fe4d1453a1c56a1c80c47ee5fabeb39df7e10bc58a578f`; its revisit: `dc31407d53a62c32316c5741d3d9f2df16e8466e01a79132a92199ec6448cda5`.
- Component-only CI host with the warmed path, twelve rounds: `d5953a14171bc984fb5bc945d4a7bfcc3b78432fbe3e803c5c8c7c61ab923bbd`.

## Limits

- This is one region, one client and one project, with 6–14 previews per comparison and 8–30 samples per on-demand cell.
- The startup variants ran on local cross-builds; the CI-built hosts confirm the executable-and-component and final behaviors.
- Client load varied, and the round trip from this client (~110 ms) dominates every warm request, so these runs can't compare warm throughput.
- Server-Timing comes from the native host only; the TypeScript twins report nothing about their own startup.
- The client's disk filled several times during these runs. Each time a run stopped with curl exit 23, and only its complete rounds count. One stopped request reached a function, as noted under the section table.
