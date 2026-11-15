# WIT

`route.wit` defines the world polyroute builds Python routes against. `deps/` holds the WASI 0.2.12 interfaces, copied unchanged from the [`wasip2`](https://crates.io/crates/wasip2) crate, version `1.0.4+wasi-0.2.12`. That crate generates them from [WebAssembly/WASI](https://github.com/WebAssembly/WASI).

The files in `deps/` are licensed under Apache-2.0 WITH LLVM-exception (see `LICENSE`).
