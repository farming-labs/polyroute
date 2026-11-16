# 0002: Call synchronous host imports without jco's task bookkeeping

Status: accepted, 2026-11-16

## Context

jco 0.24 implements the component model's async runtime in JavaScript and runs every host import through it, including imports that are synchronous on both sides. Every one of a route's `wasi:http`, `wasi:io`, and `wasi:cli` calls goes through two layers:

1. `_lowerImportBackwardsCompat` checks that the guest may leave, looks up the guest's current task, creates a subtask with a call-metadata object, calls the trampoline, and reads the result back from the subtask.
2. The trampoline creates a second task for the host side, links it to that subtask, and enters it. It runs the host function inside `_withGlobalCurrentThreadMeta`, which saves, sets, and restores the current-task register, and inside `_trackHostOperation`. Then it resolves and exits the task.

A request to the example's Rust route makes 19 host calls, Go 22, and Python 23. Measured in-process, without an HTTP server, 61% of a Rust request's time was in this glue and 4.8% in the route's own WebAssembly. jco-transpile has no option that turns it off, and older jco releases (0.1.3, 0.10, 0.18) were no faster.

## Decision

`transpileRoute` rewrites jco's bindings for each import that is synchronous on both sides: `isAsync` and `funcTypeIsAsync` are false, it isn't manually async, and it has no callback or post-return function. For each such import:

- It's wired straight to its trampoline instead of through `_lowerImportBackwardsCompat`.
- The trampoline's first statement is the may-leave check that wrapper used to run, with the same arguments.
- The host task setup is replaced with a frozen stand-in whose methods do nothing.
- The host function still runs inside `_trackHostOperation`, without `_withGlobalCurrentThreadMeta`.

Everything else in the trampoline stays: argument lifting, `markTrapped` when the host function throws, `throwIfInterrupted`, the borrow release loop, result lowering, and the debug logs. The code is in [`sync-imports.ts`](../../packages/polyroute/src/sync-imports.ts).

## Why the dropped code is safe to skip

- **The subtask and its result.** For a synchronous import, the subtask's result is the value the trampoline passes to `task.resolve`, and the subtask writes to guest memory only for async calls. The rewrite applies only when the trampoline also returns that same value, or returns nothing for an import whose core function has no result, because it writes through a result pointer or returns nothing.
- **The host task.** It exists so a host function can call back into the guest, block, or be cancelled. polyroute's host functions are synchronous and never call the guest.
- **The current-task register.** It's read by code that runs during a host call and needs to know the caller: calls back into the guest and async imports. Neither happens. While lowering a string or list result, jco calls the guest's `cabi_realloc`, and that wrapper reads the register to find the guest's thread. Without the rewrite, the register has already been restored to the guest's export task by then. With it, the register is never changed. Either way it reads the same task.
- **Borrow scope.** The host task's borrow count and lender list are never updated for these imports, since nothing in the generated code calls `addBorrowedHandle` or `addResourceLender`. Borrows the guest passes to the host are released by the loop in the trampoline, which stays.

The export side is unchanged. Each call to `handle` still runs as a jco task.

## When the rewrite doesn't apply

The patterns match jco 0.24's output exactly. An import whose code doesn't match keeps jco's code, which is correct and slower, and the other imports are still rewritten. The test suite checks the production bundle of the fixture app, which has Rust, Go, and Python routes, and fails unless every import was rewritten. So a jco update that changes its output fails polyroute's CI instead of making routes silently slower.

## Results

Measured in-process (µs per request; the median of 8 alternating rounds, with byte-identical responses across builds):

| Route  | jco's bindings | Rewritten | Speedup |
| ------ | -------------: | --------: | ------: |
| Rust   |           45.3 |      23.5 |   1.93× |
| Go     |          185.3 |      82.3 |   2.25× |
| Python |          133.9 |      97.3 |   1.38× |

Keeping the may-leave check and the trap checks costs 1 to 6 µs a request compared with dropping them too, so they stay. Over HTTP, the README's Performance section has the numbers.

## Consequences

- polyroute depends on the shape of jco's output. Upgrading jco needs the guard test to pass.
- A host function that is async, or that calls back into the guest, would need jco's task machinery. polyroute's host has neither today. Adding one, for example outbound HTTP, means revisiting this decision.
- If jco adds a fast path for imports that are synchronous on both sides, delete this rewrite.
