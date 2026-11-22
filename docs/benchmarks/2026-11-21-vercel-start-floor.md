# Vercel start floor and a smaller host

**A Vercel executable function that does nothing took 344 ms to answer an on-demand first request from the client, against 582–603 ms for the TypeScript twins, so on-demand starts can't get much more than twice as fast as TypeScript's on Vercel. Linking the host with whole-program optimization made it 27% smaller and cut on-demand first responses by 36 to 55 ms.**

## Setup

Same project, region and client as [the languages record](2026-11-21-vercel-languages.md#setup), on 2026-11-21 (PST).

- **Floor.** `floor` is the smallest `vercel_runtime` 2.4.1 function: an 840 KB static `x86_64-unknown-linux-musl` binary that answers every request with a fixed body and reports `wait` on its first response, as the host does. `floor-big` is the same binary with the host's 10.6 MB appended, so only the executable's size differs. Eight previews, created 18:48–18:55 beside the host of `main` at `2289822` and the TypeScript twins, revisited from 19:42, 47 minutes after their last request.
- **Smaller host.** CI built the host with `lto = "fat"` and `codegen-units = 1` (run `44979284672`, artifact `14737880167`, SHA-256 `dbe416009437157a90dc5f5e97ca471fdcfaff6a485647aefb0fdca30454cba6`): 7,796,456 bytes against 10,638,584 for `main`'s. Four previews ran both hosts with the same components, created 19:47–19:51; the harness, set for eight, stopped during the fourth preview's warm-up requests, after its first requests, when `vercel curl` timed out. From 19:58, a copy of `load-function.mjs` that also returns each new instance's first-response latency sent ten concurrent requests for 2 s to each native function from inside `iad1`, which started about nine instances per function per preview.

## On-demand first requests from the client

Medians in milliseconds over eight previews, with paired differences:

| Function    | Median | Paired against `floor` |
| ----------- | -----: | ---------------------: |
| `floor`     |    344 |                      — |
| `floor-big` |    379 |       +34 (5/8 slower) |
| Rust        |    476 |      +123 (8/8 slower) |
| Go          |    579 |      +231 (8/8 slower) |
| Python      |    688 |      +331 (8/8 slower) |
| Rust TS     |    592 |      +247 (8/8 slower) |
| Go TS       |    603 |      +247 (8/8 slower) |
| Python TS   |    582 |      +246 (8/8 slower) |

Every request includes the client's round trip of about 100 ms. Without it, the floor is about 245 ms against TypeScript's 480–500. Before readiness, the host spent 66, 145 and 245 ms reading and loading for Rust, Go and Python.

## New instances from inside the region

First responses of new instances, medians over 38 to 40 instances per function, with per-preview paired differences:

| Function    | `main` host | Smaller host |          Paired |
| ----------- | ----------: | -----------: | --------------: |
| Rust        |         382 |          349 |       −41 (4/4) |
| Go          |         489 |          455 |       −36 (4/4) |
| Python      |         643 |          566 |       −55 (4/4) |
| `floor`     |         267 |            — |               — |
| `floor-big` |         275 |            — | +1 (2/4 faster) |

The smaller host's `prefetch`, which reads the executable and the component before readiness, fell from 63, 73 and 88 ms to 45, 55 and 69 ms. The rest of the difference came before the host's first measured phase. Guest calls took the same time with both hosts.

## Raw data

Sample files are kept outside the repository with the scripts that produced them. Their SHA-256 digests:

- Floor first requests: `378b4f0c57c53045f324c5556a549932941e2f6d1125140bc51dc8fb0c4213df`; revisit: `c57cbda4058fa3cbfd5dea2ade953ce1481d76564490807a25df7859df3b32e2`.
- Smaller host first requests: `49f82a2779bc217727635871828e02e0d5c984464ddf3e0dfd5ff78074271413`; in-region instances: `145cd055f9603cf1cb81907786620f8c0221046041c68125b704af77606fcac8`.

## Limits

- One region, one project; four previews for the smaller host.
- The in-region instances started minutes after deployment, while the client revisit waited 47 minutes. Their absolute times differ; only the paired differences are compared.
- The size-only difference between `floor` and `floor-big` was 34 ms from the client and 1 ms from inside the region, both within the spread, so how much of the smaller host's gain comes from size alone isn't settled.
- Lambda wasn't measured, though its host is built with the same profile.
