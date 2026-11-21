# 0021: Prepare Vercel native routes before readiness

Status: implemented in the private probe, 2026-11-20. Measured on Vercel with a local cross-build of the host; the CI-built artifact is a separate verification gate. No public option or package changes.

## Problem

The first matched provider measurement (six fresh previews, farming-labs `polyroute-native-probe`) found native first requests no faster than their TypeScript twins: about equal for Rust, and 86 ms (Go) and 90 ms (Python) slower in median paired differences. [The benchmark record](../benchmarks/2026-11-20-vercel-first-requests.md) has every number.

Bundle size isn't the cause. Padding the Rust function with files matching the Go and Python components' extra raw and compressed bytes left its first requests unchanged. An opt-in `Server-Timing` header then showed what the host does and when:

- Vercel starts each function's process seconds before its first request: 3 to 26 seconds between readiness and that request on every fresh preview.
- The host deferred guest instantiation to the first request, and the component's pages faulted in from the function's file system as the guest touched them. Go's instantiation took 85 ms there and Python's first call 141 ms, against about 1 ms once the pages were cached.
- Work started on a background thread after readiness barely ran: a 0.7 MB read took 9.97 s of wall time, finishing only once the first request arrived. Vercel freezes the instance between readiness and the first request.

## Decision

Before the Vercel adapter reports readiness, it reads its own executable and the component once, start to finish, deserializes the component, and creates the instance the first request will use. For routes with outbound requests, that instance is the first idle worker.

- **Instantiation failure stops startup.** The process exits before readiness, like a missing or incompatible component (ADR 0018). Before this change, the same failure surfaced as a 500 on every request.
- **One sequential reader.** It measured about three times faster on the provider than eight parallel readers. `posix_fadvise(WILLNEED)` left the first request as slow as before, so the provider either doesn't read ahead on it or doesn't finish while frozen.
- **`serverTiming` is an opt-in diagnostic.** The manifest key adds each phase's duration as a `Server-Timing` header. It is off by default and stays private to the probe.
- **The Lambda adapter is unchanged.** Lambda starts most instances for a waiting request, and this measurement doesn't cover it.

## Alternatives and consequences

- **Lazy instantiation**, the old behavior, keeps the first request slow on the instances Vercel starts ahead of time.
- **Instantiating without reading** helps Go (the first request drops to 20 ms of guest time) but not Python, whose cost is in the first call's page faults.
- **A background thread after readiness** loses because the instance is frozen.
- **Parallel reads** are slower than one sequential reader.

Reading every page costs startup time before readiness: about 70 ms for Rust, 180 ms for Go and 320 ms for Python in these runs. Instances Vercel starts ahead of a request pay it before the request arrives. Instances started for a waiting request pay it on that request instead of the lazy page faults it replaces. The measured on-demand result is recorded below.

## Verification

- Rust formatting, Clippy with `-D warnings`, and the seven Lambda and six Vercel Rust tests pass on macOS.
- The Vercel bridge suite passes 30 groups with 1,123 requests and matching end messages against the real macOS binary. The existing non-Latin-1 header case stays skipped, not passed.
- Three new bridge checks require the first response's phases to be exactly `prefetch, load, prepare, wait, call`, with no `instantiate`, for both plain and outbound routes. They also require per-request routes to create an instance for every later request. With the `prepare` call removed, all three fail. A fourth check requires the header to be absent by default.
- On Vercel, the cross-built host removed the first request's guest startup on every pre-started instance across fourteen fresh previews. Guest time on the first request fell from 19, 103 and 149 ms (Rust, Go, Python medians) to 0.7, 1.4 and 4.3 ms.

Not verified: the Linux CI build of this source and its provider rerun, Lambda, and arm64.
