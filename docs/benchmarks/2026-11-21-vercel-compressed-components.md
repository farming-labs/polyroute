# Vercel compressed components: first requests

**Shipping the component compressed with zstd level 19 cut on-demand first requests by 98 ms for Go and 179 ms for Python.** On the Build Output CI built, native first requests were faster than their TypeScript twins on pre-started instances in every language, Go by only 5 ms. On instances started for a waiting request, Rust and Go win and Python still loses, by about 80 ms. [The first-requests record](2026-11-20-vercel-first-requests.md) covers why the host reads the component before readiness.

## Setup

Same project, region, client and timing as [the first-requests record](2026-11-20-vercel-first-requests.md#setup): farming-labs `polyroute-native-probe` previews in `iad1`, reached through `vercel curl` from an Apple M1 client, timed from TLS completion to the first response byte, with every body checked. An on-demand request is a function's next request after its instances have stopped; every one reported here had a `wait` under 16 ms.

- **Level comparison:**
  - Host: a local cross-build (`cargo zigbuild`, target `x86_64-unknown-linux-gnu.2.34`) of this change on top of `5690ab5`, SHA-256 `22a6b50fd34b016db1aa6487b12d4b93e473a958700836b50866201dc526cdd4`. Every native function in the deployment ran it.
  - Components: Go (`/api/slug`) and Python (`/api/stats`) from CI artifact `14693247977`, built at `a71fae8`. Each deployment served the raw component and copies compressed with the `zstd` command at levels 1, 3 and 19, each as its own function (`/api/slug-z1` and so on) with `serverTiming` on.
  - Deployments: ten previews, created 23:45–23:57 PST on 2026-11-20 and revisited about nine hours later. Their first requests on pre-started instances were lost with the client's scratch directory and aren't reported here.
- **CI-built Build Output:**
  - CI run `44929704588` built it at `4f8cd9c` with `build-vercel-output.mjs`. Artifact `14717343020` matched GitHub's SHA-256 `00f30eb4a47d340924dad9b04d103e6dabc69ae27e14a6f40031d53169d9c105`, and all 21 files matched the manifest CI wrote. The host's SHA-256 is `74cad4a6c5ebb463451f649eb84a1525066c6ce162a2864bd224c9ff106f5012`.
  - The native manifests add `serverTiming`; nothing else changed.
  - Deployments: eight previews, created 09:42–09:47 PST on 2026-11-21 and revisited 48–51 minutes after each was created.

## Choosing the level

Medians over ten previews, on demand, in milliseconds. First requests include the client's round trip of about 110 ms. Host-reported time is `prefetch`, `load` and `prepare`, which an on-demand request waits for:

| Component  | Go size (MB) | Go first | Go host | Python size (MB) | Python first | Python host |
| ---------- | -----------: | -------: | ------: | ---------------: | -----------: | ----------: |
| Raw        |         15.0 |      648 |     181 |             32.0 |          894 |         328 |
| zstd -1    |          5.0 |      640 |     160 |             11.9 |          884 |         291 |
| zstd -3    |          4.6 |      583 |     143 |             10.8 |          721 |         247 |
| zstd -19   |          3.7 |      562 |     142 |              8.6 |          728 |         246 |
| TypeScript |            — |      613 |       — |                — |          634 |           — |

Paired by preview, the median difference from the raw component, and how often the compressed function was faster:

| Level | Go first (ms) | Go wins | Python first (ms) | Python wins |
| ----- | ------------: | ------: | ----------------: | ----------: |
| 1     |           −40 |    6/10 |               −39 |        7/10 |
| 3     |           −66 |    9/10 |              −161 |       10/10 |
| 19    |           −98 |   10/10 |              −179 |        9/10 |

Against the TypeScript twin, level 19 measured −56 ms for Go (9/10 wins) and +108 ms for Python (2/10 wins). The raw component measured +56 ms (3/10) and +249 ms (0/10).

**Reading compressed bytes is faster on this file system.** In an earlier read test (four previews, one read each), the raw 32 MB Python component took 260–285 ms to read, about 115 MB/s. Random bytes of the same size took 97–108 ms, and the component compressed to 8.6 MB took 31–33 ms, about 270 MB/s. On demand, the level 19 host spent 88 ms reading both files and 152 ms decompressing and loading Python's component, against 319 ms reading and 7 ms loading the raw one.

**Host time explains less than half the gain.** At level 19, paired host-reported time fell by 39 ms (Go) and 84 ms (Python) while first requests fell by 98 and 179 ms. The rest happens before the host runs. These runs don't break it down.

**Levels 3 and 19 tie for Python; 19 is ahead for Go.** Level 1 saved about 40 ms in either language. Level 19 costs build time: Node's zstd took 8.9 s to compress the first 32 MB of the Node executable on the client, against 0.13 s at level 3.

## The CI-built Build Output

**Pre-started instances.** Every first request reached an instance Vercel had started at least 12.9 s earlier. Medians over eight previews:

| Function | Native first (ms) | TypeScript first (ms) | Paired native − TypeScript (ms) | Native wins | Guest time (ms) | Read and load before readiness (ms) |
| -------- | ----------------: | --------------------: | ------------------------------: | ----------: | --------------: | ----------------------------------: |
| Rust     |               117 |                   139 |                             −20 |         7/8 |            0.69 |                                  67 |
| Go       |               122 |                   129 |                              −5 |         5/8 |            1.08 |                                 142 |
| Python   |               124 |                   141 |                             −17 |         6/8 |            4.37 |                                 246 |

Guest time on the first request matches the uncompressed host's 0.7, 1.4 and 4.4 ms, because both do all their reading and loading before readiness. Go's margin is thinner than the uncompressed host's −23 ms over seven previews in the first-requests record.

**On-demand instances.** The same eight previews, revisited 48–51 minutes after each was created. All 24 native requests reported `wait` between 6.8 and 9.4 ms:

| Function | Native (ms) | TypeScript (ms) | Paired native − TypeScript (ms) | Native wins | Host-reported (ms) |
| -------- | ----------: | --------------: | ------------------------------: | ----------: | -----------------: |
| Rust     |         455 |             591 |                            −152 |         8/8 |                 66 |
| Go       |         539 |             578 |                             −30 |         6/8 |                144 |
| Python   |         677 |             585 |                             +80 |         2/8 |                254 |

The uncompressed CI-built host measured 471, 654 and 872 ms on demand in the first-requests record, against twins at 602, 611 and 607 ms. Those runs were on a different day, so the comparison isn't paired.

## Raw data

Sample files are kept outside the repository. Their SHA-256 digests:

- Level comparison revisit, ten rounds: `8be148913356a2cef7ecd60cf12efd2541e926efc526f5c127643e040189b9b7`.
- CI-built Build Output, eight rounds: `df6f311ed36de8969c01d03c3f8c759dffee43d81def16ae229eb56b67467d7b`; its revisit: `7988236d68b1dd310a17a323e60823bbe42636718aec6ec88fcb2824730167af`.

None of these runs retried a request.

## Limits

- One region, one client and one project, with eight or ten previews per comparison.
- The level comparison ran a local cross-build with copies the `zstd` command wrote, and didn't include Rust. The CI-built Build Output covers the shipped path for all three languages, at level 19 only.
- The first requests on pre-started instances from the level comparison were lost, so it makes no claim about them.
- Sizes are each compressed component alone; every function also ships the host executable, about 10.5 MB.
