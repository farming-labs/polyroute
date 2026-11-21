# Vercel compressed components: on-demand first requests

**Shipping the component compressed with zstd level 19 cut on-demand first requests by 98 ms for Go and 179 ms for Python.** Go now beats its TypeScript twin on demand. Python still loses, by about 108 ms. This covers instances Vercel starts for a waiting request; [the first-requests record](2026-11-20-vercel-first-requests.md) covers pre-started instances and the reasons for reading the component before readiness.

## Setup

Same project, region, client and timing as [the first-requests record](2026-11-20-vercel-first-requests.md#setup): farming-labs `polyroute-native-probe` previews in `iad1`, reached through `vercel curl` from an Apple M1 client, timed from TLS completion to the first response byte, with every body checked.

- **Host:** a local cross-build (`cargo zigbuild`, target `x86_64-unknown-linux-gnu.2.34`) of this change on top of `5690ab5`, SHA-256 `22a6b50fd34b016db1aa6487b12d4b93e473a958700836b50866201dc526cdd4`. Every native function in the deployment ran it.
- **Components:** Go (`/api/slug`) and Python (`/api/stats`) from CI artifact `14693247977`, built at `a71fae8`. Each deployment served the raw component and copies compressed with the `zstd` command at levels 1, 3 and 19, each as its own function (`/api/slug-z1` and so on) with `serverTiming` on.
- **Deployments:** ten previews, created 23:45–23:57 PST on 2026-11-20. Each served one round of first requests on pre-started instances; those samples were lost with the client's scratch directory and aren't reported here.
- **Revisit:** about nine hours later, ten `/api/warmup` requests per preview, then one request to every function, in an order rotated each preview. All 80 native requests reported `wait` between 6.8 and 16 ms, so each one met an instance started for it.

## Results

Medians over ten previews, in milliseconds. First requests include the client's round trip of about 110 ms. Host-reported time is `prefetch`, `load` and `prepare`, which an on-demand request waits for:

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

## Raw data

The sample file is kept outside the repository. SHA-256 `8be148913356a2cef7ecd60cf12efd2541e926efc526f5c127643e040189b9b7` (ten complete revisit rounds, no curl retries).

## Limits

- One region, one client, one project, and ten previews; Rust wasn't part of this run.
- The host is a local cross-build, and the compressed copies were written by the `zstd` command, not by `build-vercel-output.mjs`.
- The first requests on pre-started instances from the same previews were lost, so this record makes no claim about them.
- Sizes are each compressed component alone; every function also ships the host executable, about 10.5 MB.
