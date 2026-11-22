# 0022: Ship Vercel components compressed

Status: implemented in the private probe, 2026-11-21. Measured on Vercel with a local cross-build and with the Build Output CI built. No public option or package changes.

## Problem

[ADR 0021](0021-prepare-vercel-routes-before-readiness.md) reads the host executable and the component before readiness. That made native first requests beat TypeScript on instances Vercel starts ahead of a request. An instance started for a waiting request pays for those reads on the request, and there Go and Python lost to their twins: 642 and 851 ms against about 606 and 602 ms.

The function file system reads compressible files slowly. Reading the raw 32 MB Python component took 260–285 ms, about 115 MB/s. Random bytes of the same size took about 100 ms, and the component compressed with zstd to 8.6 MB took about 32 ms.

## Decision

`build-vercel-output.mjs` compresses each native component with zstd level 19 and writes it as `route.cwasm.zst`. A component path ending in `.zst` makes the Vercel host read the file, decompress it into memory before readiness, and deserialize the component from there.

- **Fail closed.** A `.zst` file that isn't zstd, or whose frame doesn't record its decompressed size, stops the host before readiness, and the message says how to compress it. The build script writes the size into the frame header (`pledgedSrcSize`).
- **Level 19.** Ten previews served the raw component and levels 1, 3 and 19 side by side, revisited about nine hours later. Paired against raw, on-demand first requests improved by 98 ms for Go (10/10 previews) and 179 ms for Python (9/10). Level 3 measured −66 and −161 ms, and level 1 about −40 ms for both. [The benchmark record](../benchmarks/2026-11-21-vercel-compressed-components.md) has every number.
- **An in-memory file on Linux.** The Linux host decompresses into an anonymous in-memory file (`memfd_create`) and loads the component from it with `Component::deserialize_file`. Wasmtime maps a file's pages directly for the code and the initial memory images; from a byte slice it copies the component into new memory and copies each memory image again. Over about 35 new instances per function on four previews, started from inside `iad1`, the host's median `load` fell from 150 to 132 ms for Python and from 67 to 61 ms for Go, and `prepare` from 6.9 to 1.6 ms and from 3.2 to 1.9 ms. Their first responses measured 21 and 10 ms faster in per-preview medians, each faster on two of four previews, inside the spread. Other platforms keep the byte-slice path.
- **Node 22.15 or later** builds the output, because Node's `zlib` gained zstd in 22.15. The repository's root `engines` now says so; the published packages still support Node 22.
- **The Lambda adapter is unchanged.** Its packages still ship `route.cwasm`, and this measurement doesn't cover Lambda.

## Alternatives and consequences

- **Raw components** keep Go and Python behind their twins on demand, by 56 and 249 ms in the same previews.
- **Level 3** ties level 19 for Python and trails it for Go. It compresses about 70 times faster; level 19 adds about 9 s per 32 MB to a build on the M1 client, which a benchmark build can afford.
- **Compressing the executable as well** wasn't tried. It would need a decompressing stub in front of the host, such as UPX.

On the Build Output CI built, native first requests on pre-started instances stayed ahead of their twins: −20, −5 and −17 ms paired (Rust, Go, Python), with the same guest time as before. On demand, Rust and Go beat their twins (−152 and −30 ms) and Python lost by 80 ms (2/8 previews). Until Python wins on demand too, native routes still miss the cold-start target on Vercel. The host-reported time explains less than half of the level comparison's gain; the rest is spent before the host runs, so fewer deployed bytes may matter as much as fewer bytes read.

## Verification

- The Vercel Rust tests require a `.zst` file without a recorded size, a non-zstd `.zst` file and a missing `.zst` file to fail, each naming the problem.
- The Vercel bridge suite requires compressed Rust, Go and Python components to serve the same two responses as the raw ones, and a non-zstd `.zst` file to stop the host before readiness. It passed against the macOS host before this change was rebased onto ADR 0021's; CI runs it against the Linux host.
- The packaging test requires each native function to contain `route.cwasm.zst` that decompresses to the original bytes and a manifest naming it. It fails against the previous build script.
- CI run `44929704588` passed all ten jobs at `4f8cd9c`, including the Linux bridge suite and the Build Output check, which starts the real host on `route.cwasm.zst`.
- That run's Build Output, deployed unchanged except for `serverTiming`, served every first, warm and on-demand request with the expected body on eight previews.

Not verified: Lambda and arm64.
