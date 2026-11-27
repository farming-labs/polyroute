# Polyroute

Write HTTP handlers in Rust, Go, or Python and compile them to WebAssembly with Vite.

This is an experimental prerelease. Install it in a Vite 8 project:

```sh
pnpm add -D @farming-labs/polyroute@beta
```

```ts
import { defineConfig } from "vite";
import { polyroute } from "@farming-labs/polyroute";

export default defineConfig({ plugins: [polyroute()] });
```

Import the route from server code and call its Fetch handler. With Farm's experimental Rust route integration, put the plugin in `vite.plugins` and write the handler in `src/app/api/<name>/route.rs`.

The build machine needs the toolchain for the route's language. Deploy the generated JavaScript server together with its Wasm files. This package uses V8 by default. The optional Wasmtime addon is available from source.

[Toolchain setup and examples](https://github.com/farming-labs/polyroute#quick-start)
