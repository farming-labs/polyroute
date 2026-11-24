# 0024: Compile routes without address maps or symbols

Status: implemented, 2026-11-23. Local and CI checks pass. The x86_64 components are measured below. Start times on Vercel aren't measured: the probe project was paused when the comparison previews were deployed, and Vercel blocked them.

## Problem

Before a native route answers its first request, the Vercel host reads its compressed component, decompresses it and deserializes it. For Python those steps took about 150 ms of a 397 ms on-demand start on 2026-11-22, and they scale with the component's size. Python's component decompresses to about 32 MB.

Wasmtime adds two kinds of metadata to every compiled component by default:

- **An address map.** It maps each machine-code address back to a Wasm offset, so guest backtraces can show `0x1a2b`-style positions.
- **A symbol table.** It names each compiled function for profilers and for `wasmtime objdump`.

Neither one is used to run a route. Compiled with the Wasmtime 50.0.1 CLI on an M1, Python's statistics route measured 31,269,416 bytes with both, and 27,230,696 without them (−13%). Compressed with zstd level 19, it went from 8,054,507 to 6,969,898 bytes (−13%). Without the address map alone, it was 28,762,584 bytes. Without the symbols alone, it was 29,737,536.

## Decision

The addon's engine compiles with `generate_address_map(false)` and `debug_symbols(false)`. It is the only engine that compiles routes, so the Node runtime and the Vercel probe both get the smaller components.

- **Loading must match.** Wasmtime rejects a component whose symbol setting differs from the loading engine's. The addon loads with the engine that compiled the component. The Vercel host sets `debug_symbols(false)` too. The address map can differ between compiling and loading.
- **The cache format goes from 2 to 3.** Components cached by an earlier version carry symbols, so the new engine would reject them. They stay on disk under their old key and get recompiled under a new one.
- **Guest backtraces lose Wasm offsets.** A trap still reports its message and the function names Wasmtime reads from the component's name section. No polyroute error or test depends on the offsets.

## Alternatives and consequences

- **Keeping the address map** keeps offsets in backtraces. It accounts for about 2.5 MB of the 4 MB saved.
- **A separate debug build** would keep offsets on demand. Nothing asks for that yet, and it would add a second cache key.
- **Smaller Python components through componentize-py** remain possible. About 10.4 MB of the 17.7 MB component is the interpreter's pre-initialized heap, and 6 MB is the interpreter's code. This change doesn't touch either.

## Sizes on x86_64

CI built the Vercel output for `main` at `7655ad3` (run `45078259008`) and for this change (run `45293021210`). Each native function's `route.cwasm.zst`, compressed as shipped and decompressed:

| Route  | `main` compressed |        This change | `main` decompressed |         This change |
| ------ | ----------------: | -----------------: | ------------------: | ------------------: |
| Rust   |           190,550 |   151,103 (−20.7%) |             683,168 |    532,520 (−22.1%) |
| Go     |         3,743,403 | 3,130,220 (−16.4%) |          14,988,560 | 12,953,880 (−13.6%) |
| Python |         9,020,317 | 7,563,069 (−16.2%) |          31,958,352 | 28,115,816 (−12.0%) |

The host reads 1.46 MB less and decompresses 3.84 MB less for Python, and 0.61 MB and 2.03 MB less for Go. On 2026-11-22, Python's `load`, mostly decompressing, took 105 ms for 32 MB, and `prefetch` read about 15 MB in 47 ms. If both scale with bytes, Python's host phases would drop by about 17 ms and Go's by about 8 ms. That is an estimate, not a measurement.

## Verification

- `precompiled_code_has_no_address_map_or_symbol_table` compiles a module and requires the artifact to have no `.wasmtime.addrmap` section and no function symbols. It failed without each setting.
- `precompiled_code_runs_without_optional_host_cpu_features` loads that artifact into a compiler-free engine with `debug_symbols(false)`. Without the compiler's setting, the load failed.
- The cache test seeds formats 1 and 2 with stale bytes and requires a fresh compile under a new key. It failed for format 2 before the bump.
