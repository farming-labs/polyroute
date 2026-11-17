import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { PolyrouteError } from "./errors.js";
import { LANGUAGES, findLanguage } from "./languages/index.js";
import { INSTANCE_MODES, type InstanceMode } from "./runtime/index.js";
import { transpileRoute, type TranspiledRoute } from "./transpile.js";

export interface PolyrouteOptions {
  /**
   * How a route's requests map to instances of its component.
   *
   * - `"reuse"` (default): one instance per route serves every request, one
   *   at a time, the way a long-running server process does. Global state
   *   persists between requests. An instance that traps is thrown away.
   * - `"per-request"`: every request gets a fresh instance. Nothing survives a
   *   request, at a large cost per request.
   */
  instances?: InstanceMode;
}

interface ResolvedPolyrouteOptions {
  instances: InstanceMode;
}

function resolveOptions(options: PolyrouteOptions): ResolvedPolyrouteOptions {
  const instances = options.instances ?? "reuse";
  if (!INSTANCE_MODES.includes(instances)) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`instances\` must be ${INSTANCE_MODES.map((mode) => `"${mode}"`).join(" or ")}, but it's ${JSON.stringify(instances)}.`,
    );
  }
  return { instances };
}

const RUNTIME_ID = "@farming-labs/polyroute/runtime";
const BINDINGS_ID = "virtual:polyroute/bindings/";
const RESOLVED_BINDINGS_ID = `\0${BINDINGS_ID}`;
const ROUTE_FILE = new RegExp(
  `\\.(?:${LANGUAGES.flatMap((language) => language.extensions.map((extension) => extension.slice(1))).join("|")})(?:\\?.*)?$`,
);
// Vite's own asset queries, such as `route.rs?raw` or `module.wasm?init`.
const VITE_QUERY = /[?&](?:raw|url|init|inline|no-inline|worker|sharedworker)(?:[&=]|$)/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function runtimeEntry(): string {
  const built = fileURLToPath(new URL("./runtime/index.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("./runtime/index.ts", import.meta.url));
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Where a build writes a core module, relative to the chunk that loads it. */
function coreModuleFile(key: string, name: string): string {
  return `polyroute/${key}/${name}`;
}

/**
 * The module a route file compiles to. With `coreModuleFiles`, it loads its
 * core modules from files next to its chunk instead of carrying them inline, so
 * a server bundle doesn't parse every route's WebAssembly when it starts.
 */
export function createRouteModule(
  label: string,
  transpiled: TranspiledRoute,
  instances: InstanceMode,
  requestsPerInstance?: number,
  coreModuleFiles = false,
): string {
  const coreModules = Object.entries(transpiled.coreModules)
    .map(([name, encoded]) => {
      const source = coreModuleFiles
        ? `new URL(${JSON.stringify(`./${coreModuleFile(transpiled.key, name)}`)}, import.meta.url)`
        : JSON.stringify(encoded);
      return `    ${JSON.stringify(name)}: ${source},`;
    })
    .join("\n");
  return [
    `import { createWasiHttpHandler } from ${JSON.stringify(RUNTIME_ID)};`,
    `import { instantiate } from ${JSON.stringify(`${BINDINGS_ID}${transpiled.key}.js`)};`,
    "",
    "const route = createWasiHttpHandler({",
    `  route: ${JSON.stringify(label)},`,
    `  instances: ${JSON.stringify(instances)},`,
    ...(requestsPerInstance === undefined
      ? []
      : [`  requestsPerInstance: ${JSON.stringify(requestsPerInstance)},`]),
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

/**
 * Builds route files written in other languages into modules that export a
 * web-standard fetch handler.
 */
export function polyroute(options: PolyrouteOptions = {}): Plugin {
  const { instances } = resolveOptions(options);
  let config: ResolvedConfig;
  const bindings = new Map<string, string>();
  // Route modules a build loads, by module ID, so their core modules can be
  // written next to whichever chunk each one ends up in.
  const builtRoutes = new Map<string, TranspiledRoute>();

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
      filter: { id: [ROUTE_FILE, /^\0virtual:polyroute\//] },
      async handler(id) {
        if (id.startsWith(RESOLVED_BINDINGS_ID)) {
          const key = id.slice(RESOLVED_BINDINGS_ID.length).replace(/\.js$/, "");
          const code = bindings.get(key);
          if (code === undefined) {
            throw new PolyrouteError(
              "BUILD_FAILED",
              `polyroute has no bindings for \`${key}\`. Import the route file itself, not its generated bindings.`,
            );
          }
          return code;
        }

        if (VITE_QUERY.test(id)) return null;
        const routeFile = id.replace(/\?.*$/, "");
        const language = findLanguage(routeFile);
        if (language === undefined) return null;
        if (language.accepts !== undefined && !(await language.accepts(routeFile))) return null;

        const label = toPosix(path.relative(config.root, routeFile));
        if (this.environment.config.consumer === "client") {
          throw new PolyrouteError(
            "CLIENT_IMPORT",
            `\`${label}\` is a server route but was imported from browser code. Import it only from server code.`,
          );
        }

        const cacheDir = path.join(config.cacheDir, "polyroute");
        const started = performance.now();
        const { wasm, sources } = await language.build({ routeFile, label, cacheDir });
        for (const source of sources) this.addWatchFile(source);
        const transpiled = await transpileRoute(wasm, label, cacheDir, language.handlerHint);
        bindings.set(transpiled.key, transpiled.bindings);
        config.logger.info(
          `polyroute: built ${label} (${(wasm.byteLength / 1024).toFixed(0)} KiB) in ${Math.round(performance.now() - started)} ms`,
          { timestamp: true },
        );
        const coreModuleFiles = config.command === "build";
        if (coreModuleFiles) builtRoutes.set(id, transpiled);
        return createRouteModule(
          label,
          transpiled,
          instances,
          language.requestsPerInstance,
          coreModuleFiles,
        );
      },
    },

    generateBundle: {
      // After Vite's own hook, which drops every emitted asset from a server
      // build unless `build.emitAssets` is set. These files are code the server
      // reads at runtime, so they're emitted once that has run.
      order: "post",
      handler(_, bundle) {
        const emitted = new Set<string>();
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          const dir = path.posix.dirname(chunk.fileName);
          for (const id of chunk.moduleIds) {
            const transpiled = builtRoutes.get(id);
            if (transpiled === undefined) continue;
            for (const [name, encoded] of Object.entries(transpiled.coreModules)) {
              const fileName = path.posix.join(dir, coreModuleFile(transpiled.key, name));
              if (emitted.has(fileName)) continue;
              emitted.add(fileName);
              this.emitFile({ type: "asset", fileName, source: Buffer.from(encoded, "base64") });
            }
          }
        }
      },
    },
  };
}
