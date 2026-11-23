# 0024: Compile routes without address maps or symbols

Status: implemented, 2026-11-23. Local checks pass. Vercel measurement is in progress.

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

## Verification

- `precompiled_code_has_no_address_map_or_symbol_table` compiles a module and requires the artifact to have no `.wasmtime.addrmap` section and no function symbols. It failed without each setting.
- `precompiled_code_runs_without_optional_host_cpu_features` loads that artifact into a compiler-free engine with `debug_symbols(false)`. Without the compiler's setting, the load failed.
- The cache test seeds formats 1 and 2 with stale bytes and requires a fresh compile under a new key. It failed for format 2 before the bump.
