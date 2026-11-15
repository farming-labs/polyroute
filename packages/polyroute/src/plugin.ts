import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { PolyrouteError } from "./errors.js";
import { buildRustRoute } from "./rust.js";
import { transpileRoute, type TranspiledRoute } from "./transpile.js";

const RUNTIME_ID = "@farming-labs/polyroute/runtime";
const BINDINGS_ID = "virtual:polyroute/bindings/";
const RESOLVED_BINDINGS_ID = `\0${BINDINGS_ID}`;
const RUST_ROUTE = /\.rs(?:\?.*)?$/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function runtimeEntry(): string {
  const built = fileURLToPath(new URL("./runtime/index.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("./runtime/index.ts", import.meta.url));
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

export function createRouteModule(label: string, transpiled: TranspiledRoute): string {
  const coreModules = Object.entries(transpiled.coreModules)
    .map(([name, encoded]) => `    ${JSON.stringify(name)}: ${JSON.stringify(encoded)},`)
    .join("\n");
  return [
    `import { createWasiHttpHandler } from ${JSON.stringify(RUNTIME_ID)};`,
    `import { instantiate } from ${JSON.stringify(`${BINDINGS_ID}${transpiled.key}.js`)};`,
    "",
    "const route = createWasiHttpHandler({",
    `  route: ${JSON.stringify(label)},`,
    "  instantiate,",
    "  coreModules: {",
    coreModules,
    "  },",
    "});",
    "",
    "export default route;",
    "export const fetch = route.fetch;",
    ...METHODS.map((method) => `export const ${method} = route.fetch;`),
    "",
  ].join("\n");
}

/** Builds `.rs` route files into modules that export a web-standard fetch handler. */
export function polyroute(): Plugin {
  let config: ResolvedConfig;
  const bindings = new Map<string, string>();

  return {
    name: "polyroute",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
    },

    resolveId: {
      filter: { id: [/^@farming-labs\/polyroute\/runtime$/, /^virtual:polyroute\//] },
      handler(id) {
        if (id === RUNTIME_ID) return runtimeEntry();
        return `\0${id}`;
      },
    },

    load: {
      filter: { id: [RUST_ROUTE, /^\0virtual:polyroute\//] },
      async handler(id) {
        if (id.startsWith(RESOLVED_BINDINGS_ID)) {
          const key = id.slice(RESOLVED_BINDINGS_ID.length).replace(/\.js$/, "");
          const code = bindings.get(key);
          if (code === undefined) {
            throw new PolyrouteError(
              "BUILD_FAILED",
              `polyroute has no bindings for \`${key}\`. Import the \`.rs\` route itself, not its generated bindings.`,
            );
          }
          return code;
        }

        const routeFile = id.replace(/\?.*$/, "");
        const label = toPosix(path.relative(config.root, routeFile));
        if (this.environment.config.consumer === "client") {
          throw new PolyrouteError(
            "CLIENT_IMPORT",
            `\`${label}\` is a server route but was imported from browser code. Import it only from server code.`,
          );
        }

        const cacheDir = path.join(config.cacheDir, "polyroute");
        const started = performance.now();
        const { wasm, sources } = await buildRustRoute({ routeFile, label, cacheDir });
        for (const source of sources) this.addWatchFile(source);
        const transpiled = await transpileRoute(wasm, label, cacheDir);
        bindings.set(transpiled.key, transpiled.bindings);
        config.logger.info(
          `polyroute: built ${label} (${(wasm.byteLength / 1024).toFixed(0)} KiB) in ${Math.round(performance.now() - started)} ms`,
          { timestamp: true },
        );
        return createRouteModule(label, transpiled);
      },
    },
  };
}
