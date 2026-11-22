# Vercel languages: first requests, on-demand starts and requests per second

**On Vercel, native Rust, Go and Python routes beat their TypeScript twins on first requests to pre-started instances and tie them on light routes under load. Rust also wins on demand. Go ties there and Python loses by about 95 ms. Under concurrent CPU-heavy load, the executable host on `main` queues requests and serves a fifth to a quarter of TypeScript's rate.** The same components run in Node through polyroute's wasmtime runtime lose every first-request comparison in medians, by 50 to 290 ms, and serve the heavy load 1.4× faster than TypeScript.

## Setup

Same project, region, client and timing as [the first-requests record](2026-11-20-vercel-first-requests.md#setup): farming-labs `polyroute-native-probe` previews in `iad1`, first requests through `vercel curl` from an Apple M1 client, timed from TLS completion to the first response byte, with every body checked. Native functions report their startup phases with `serverTiming`, which tells pre-started instances (`wait` of seconds) from on-demand ones (`wait` under 20 ms).

Three sets of eight previews, all on 2026-11-21 (PST):

- **A, six functions.** The Build Output CI built at `main` (`8ad9e1d`, run `44938104112`, artifact `14720319162`, SHA-256 `ac6eb135c0ce6cce2c4f5b3ab19fef1ce7b96cac42ccd3cf02f3130cb4c1b58e`; host `74cad4a6…`), with `serverTiming` added. Created 13:15–13:21 and revisited 14:51–15:03, at least 31 minutes after their last request.
- **B, nine functions.** Set A's output plus `*-node`: Node 24 functions that serve the same routes through `createWasmtimeHandler`, using the addon, components and runtime code from CI's `polyglot-wasmtime-Linux-X64` build at `main` (artifact `14721160473`, SHA-256 `0e27d22ae9ae0120987708315e5a667579d1918c2545d777cf969fd2102486ba`). They load the addon and component on their first request, as the package does. Created 14:30–14:43 and revisited 15:35–15:40, at least 45 minutes after their last request.
- **C, paired.** The Build Output CI built for this change (run `44961087515`, artifact `14729791826`, SHA-256 `ad02999e0ae4baa564a09f008fc2a2a23682c5e78c02f5b1a983f4a23b76e6df`), whose host is byte-identical to `main`'s, plus set B's `*-node` functions. Created 15:40–15:49. It also carried `busy-*` functions with an early revision of a host change that this record leaves out.

Requests per second come from `measure-vercel-load.mjs --from vercel` on set C: each run's load starts in `/api/load`, inside `iad1`, with 1 s of warmup and 5 s measured per function at 1, 10 and 50 connections, and `/api/warmup` first and last as the A/A control. Light routes are the benchmark inputs (primes below 10,000, a slug, statistics of four numbers); the heavy one counts primes below 1,000,000, about 205 ms of guest time.

## First requests on pre-started instances

Every native first request met an instance Vercel had started at least 13 s earlier. Medians in milliseconds, paired by preview, with how often each variant beat TypeScript:

| Set | Rust native − TS | Go native − TS | Python native − TS | Rust node − TS | Go node − TS | Python node − TS |
| --- | ---------------: | -------------: | -----------------: | -------------: | -----------: | ---------------: |
| A   |        −26 (7/8) |      −14 (5/8) |          −17 (6/8) |              — |            — |                — |
| B   |        −10 (4/8) |       −6 (4/8) |          −18 (6/8) |      +61 (0/8) |   +130 (2/8) |       +209 (1/8) |
| C   |        −22 (8/8) |      −27 (8/8) |          −22 (7/8) |      +50 (0/8) |   +144 (0/8) |       +215 (0/8) |

In set C, native first requests took 117, 112 and 121 ms against 140, 142 and 135 ms for TypeScript. Guest time on the first request was 0.70, 1.11 and 4.37 ms: the host reads and instantiates before readiness ([ADR 0021](../decisions/0021-prepare-vercel-routes-before-readiness.md)). The Node variants pay for loading on that request instead.

## On-demand first requests

Every native request reported `wait` between 6.5 and 18 ms. Medians in milliseconds:

| Set | Rust native | Rust TS | Go native | Go TS | Python native | Python TS | Rust node | Go node | Python node |
| --- | ----------: | ------: | --------: | ----: | ------------: | --------: | --------: | ------: | ----------: |
| A   |         441 |     659 |       611 |   574 |           720 |       633 |         — |       — |           — |
| B   |         462 |     583 |       555 |   592 |           675 |       600 |       651 |     816 |         863 |

Paired native − TypeScript: Rust −165 ms (8/8) and −115 ms (8/8), Go +46 ms (3/8) and −43 ms (6/8), Python +95 ms (1/8) and +94 ms (1/8). The Node variants lost every on-demand pair, by 99, 224 and 290 ms in medians. Before readiness the native host spent 63–68 ms (Rust), 138–145 ms (Go) and 245–250 ms (Python) reading and loading.

## Requests per second, light routes

Medians over set C, from inside `iad1`. Every function answers in about 23 ms at the median, Vercel's own request path, so the rate follows the connection count:

| Connections |  Rust | Rust node | Rust TS |    Go | Go node | Go TS | Python | Python node | Python TS |
| ----------: | ----: | --------: | ------: | ----: | ------: | ----: | -----: | ----------: | --------: |
|           1 |    37 |        35 |      36 |    37 |      34 |    33 |     34 |          31 |        35 |
|          10 |   384 |       370 |     375 |   384 |     362 |   372 |    379 |         359 |       375 |
|          50 | 1,969 |     1,878 |   1,868 | 2,019 |   1,848 | 1,928 |  1,987 |       1,854 |     1,934 |

Paired per preview, native over TypeScript: 1.05×, 1.06× and 1.01× at 1 connection; 1.03×, 1.03× and 1.02× at 10; 1.07×, 1.01× and 1.04× at 50 (Rust, Go, Python), winning 4 to 8 of 8. The Node variants measured 0.94× to 1.02×. The A/A control moved by 0.3%, 2.3% and 4.7% at the three counts, about as much as these leads, so on light routes the languages tie. At 50 connections the generator used up to 0.68 of a CPU, so that row may be limited by the generator.

Native functions started a new instance for most concurrent connections: 71–72 instance starts over the eight 10-connection runs of each function, and 261–285 over the 50-connection runs. Vercel's Node functions share instances across concurrent requests ("optimized concurrency" in Fluid compute), and the harness can't count their instances.

## Requests per second, CPU-heavy route

Primes below 1,000,000, medians over set C:

| Connections |         Rust native |      Rust node |        Rust TS |
| ----------: | ------------------: | -------------: | -------------: |
|           1 |    4.2 (p50 233 ms) |   4.2 (239 ms) |   2.6 (367 ms) |
|          10 |  8.0 (p50 1,301 ms) |  42.9 (232 ms) |  29.1 (366 ms) |
|          50 | 32.4 (p50 1,108 ms) | 219.9 (229 ms) | 158.7 (360 ms) |

The Rust code itself runs 1.6× faster than TypeScript: one connection at a time, both Rust variants beat TypeScript on 7 of 8 previews. With concurrent requests, the executable host fell to 0.28× and 0.20× of TypeScript, losing all 16 pairs, while the Node variant kept a single request's latency and served 1.47× and 1.39×. Its p50 rose to 1.1–1.3 s, five times a single call, so requests waited on instances already running one; at 50 connections it started 85 instances over eight runs, about 11 per run. Vercel sends concurrent requests to an executable instance while it answers `/_vercel/ping` promptly, and the host keeps answering during a guest call while it runs guest calls one at a time.

## From the client

The same harness from the M1 client wasn't usable. Every request includes the client's round trip of about 100 ms, so at a given connection count every function measured within the noise. The client's network also dropped for about 20 minutes during one run and, at 50 connections, refused bursts of new connections to every host tried, Google included. Those samples are kept but not reported.

## Raw data

Sample files are kept outside the repository. Their SHA-256 digests:

- Set A first requests: `719a1ec46007dee72a0bd3a455e7e4d059c1eb3f92ab262a022d9072c40f4827`; revisit: `60ed21106bf55416d622a5f0dc8fe68e4e24158a31fd8bd54b597e0cb5089fc6`; client load: `115c98aa20765cbd78be51d0c30d868d9a95ca12d66912a0ea47833a4e807178`.
- Set B first requests: `69443424505ab129aef080476627aae4dcc1b53ffd789b76f5b191ec2bd91ee7`; revisit: `9c0bb81ca3cec0fc2049dc22c5434889073c70eba3d293f4ac1d4d5905334c32`; client load: `ba7a68b2223bf99a4eaa64020eec7d60d924ac8418318bea47b207fc2dd508f2`.
- Set C first requests: `850915212249952e445aa441f5ddda8809b576dbcb8de18645e347aecfb704ac`; light load: `a65068dca5337f60c4036d1bf18d6dab13b341e6058f98ed99bdecb9223e3c91`; heavy load: `a74c400fc75fbd7f056a42cc764b8f6d2a48d87c17212bde5b82b870c01b0672`.

No first request was retried, and no in-region run was aborted.

## Limits

- One region, one client and one project, with eight previews per comparison.
- On-demand runs waited at least 31 minutes in set A and 45 in set B. Native `wait` confirms those instances had stopped; nothing confirms it for the Node functions.
- The in-region generator shares Vercel's edge and region with the functions it measures, and at 50 connections it approached a full CPU.
- The Node variants load lazily, as the package does today. Loading before readiness, as the executable host does, wasn't tried.
- Lambda and arm64 weren't measured.
