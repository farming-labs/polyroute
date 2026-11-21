# 0021: Prepare Vercel native routes before readiness

Status: implemented in the private probe, 2026-11-20. Measured on Vercel with local cross-builds and CI-built hosts. No public option or package changes.

## Problem

The first matched provider measurement (six fresh previews, farming-labs `polyroute-native-probe`) found native first requests no faster than their TypeScript twins: about equal for Rust, and 86 ms (Go) and 90 ms (Python) slower in median paired differences. [The benchmark record](../benchmarks/2026-11-20-vercel-first-requests.md) has every number.

Bundle size isn't the cause on pre-started instances. Padding the Rust function with files matching the Go and Python components' extra raw and compressed bytes left its first requests unchanged. An opt-in `Server-Timing` header then showed what the host does and when:

- Vercel starts each function's process seconds before its first request: 3 to 26 seconds between readiness and that request on every fresh preview.
- The host deferred guest instantiation to the first request, and the component's pages faulted in from the function's file system as the guest touched them. Go's instantiation took 85 ms there and Python's first call 141 ms, against about 1 ms once the pages were cached.
- Work started on a background thread after readiness barely ran: a 0.7 MB read took 9.97 s of wall time, finishing only once the first request arrived. Vercel freezes the instance between readiness and the first request.

## Decision

Before the Vercel adapter reports readiness, it reads its own executable and the component once, start to finish, deserializes the component, and creates the instance the first request will use. For routes with outbound requests, that instance is the first idle worker.

- **Instantiation failure stops startup.** The process exits before readiness, like a missing or incompatible component (ADR 0018). Before this change, the same failure surfaced as a 500 on every request.
- **Both files, whole.** Reading only the component left about 11 ms of host page faults on the first request, and on twelve CI-built previews its first requests only tied the TypeScript twins. With the executable read as well, guest time on the first request was 0.7, 1.4 and 4.4 ms (Rust, Go, Python), and native first requests beat their twins in four of five paired previews per language. Reading only the component's `.text` or `.rodata.wasm` section left Python's first request with 89 or 75 ms of guest time.
- **One sequential reader.** It measured about three times faster on the provider than eight parallel readers. `posix_fadvise(WILLNEED)` left the first request as slow as before, so the provider either doesn't read ahead on it or doesn't finish while frozen.
- **`serverTiming` is an opt-in diagnostic.** The manifest key adds each phase's duration as a `Server-Timing` header. It is off by default and stays private to the probe.
- **The Lambda adapter is unchanged.** Lambda starts most instances for a waiting request, and this measurement doesn't cover it.

## Alternatives and consequences

- **Lazy instantiation**, the old behavior, keeps the first request slow on the instances Vercel starts ahead of time.
- **Instantiating without reading** helps Go (about 21–26 ms of guest time on the first request instead of 103) but not Python, whose cost is in the first call's page faults.
- **Reading only the component** ties TypeScript on pre-started instances, as above, and saves about 36 ms on Rust's and Go's on-demand starts.
- **A background thread after readiness** loses because the instance is frozen.
- **Parallel reads** are slower than one sequential reader.

**On-demand starts pay for the reads.** An instance started for a waiting request reads both files on that request instead of faulting in only the pages it touches. On-demand first requests after 45 idle minutes, medians with sample counts, measured from the client and including its ~110 ms round trip:

| Function | Lazy (ms) | Component only (ms) | Executable and component (ms) | TypeScript twin (ms) |
| -------- | --------: | ------------------: | ----------------------------: | -------------------: |
| Rust     |  448 (20) |             445 (8) |                      471 (24) |             596 (30) |
| Go       |  593 (20) |             589 (8) |                      642 (24) |             606 (30) |
| Python   |  725 (20) |             866 (8) |                      851 (24) |             602 (30) |

Rust stays well ahead of its twin. Go and Python lose: Go by 36 ms, and Python by 249 ms, against 123 ms when lazy. We accept that because Vercel keeps pre-warmed instances for production deployments on paid plans ([Fluid compute](https://vercel.com/fluid)), so a pre-started instance is the case this host meets most. On-demand starts also pay a platform cost that grows with the bundle, about 290 ms for Rust's 11 MB and 440 ms for Python's 43 MB. Fewer bytes, deployed and read, are the next step. Until Go and Python beat their twins on demand, native routes don't meet the cold-start target on Vercel.

## Verification

- Rust formatting, Clippy with `-D warnings`, and the Lambda and Vercel Rust tests pass on macOS.
- The Vercel bridge suite passes against the real macOS binary. The existing non-Latin-1 header case stays skipped, not passed.
- Three new bridge checks require the first response's phases to be exactly `prefetch, load, prepare, wait, call`, with no `instantiate`, for both plain and outbound routes. They also require per-request routes to create an instance for every later request. With the `prepare` call removed, all three fail. A fourth check requires the header to be absent by default.
- On Vercel, every first request in these runs reached a pre-started instance, and the CI-built host's guest time on that request was 0.7, 1.4 and 4.4 ms, against 19, 103 and 149 ms for the lazy host.

Not verified: Lambda and arm64.
