import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { PolyrouteError } from "./errors.js";
import { LANGUAGES, findLanguage } from "./languages/index.js";
import { INSTANCE_MODES, type InstanceMode } from "./runtime/index.js";
import { createOutboundPolicy, type OutboundOptions } from "./runtime/outbound.js";
import { transpileRoute, type TranspiledRoute } from "./transpile.js";
import { precompileRoute, type PrecompiledRoute } from "./wasmtime.js";

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
  /**
   * Lets routes send HTTP requests with their language's own client, such as
   * wstd's `Client` in Rust or `net/http` with `wasihttp` in Go, to the hosts
   * in `allow`. Without it, a route that sends requests fails to build.
   *
   * @example
   * polyroute({ outbound: { allow: ["api.github.com", "*.example.com"] } })
   */
  outbound?: OutboundOptions;
  /** Opt-in features that may change or go away in any release. */
  experimental?: ExperimentalOptions;
}

/**
 * What runs a route's WebAssembly.
 *
 * - `"jco"` (default): jco transpiles each route to JavaScript that runs its
 *   core modules in the JavaScript engine's WebAssembly.
 * - `"wasmtime"`: `vite build` compiles each route to machine code for the
 *   building machine, and the server runs it in wasmtime through a Node-API
 *   addon. Needs the `@farming-labs/polyroute-wasmtime` package, and the server
 *   must run on the same OS and architecture as the build. Dev still uses jco,
 *   and routes that send HTTP requests aren't supported yet.
 */
export type Runtime = "jco" | "wasmtime";

export const RUNTIMES: readonly Runtime[] = ["jco", "wasmtime"];

export interface ExperimentalOptions {
  /** Defaults to `"jco"`. See {@link Runtime}. */
  runtime?: Runtime;
}

interface ResolvedPolyrouteOptions {
  instances: InstanceMode;
  outbound: OutboundOptions | undefined;
  runtime: Runtime;
}

function resolveOptions(options: PolyrouteOptions): ResolvedPolyrouteOptions {
  const instances = options.instances ?? "reuse";
  if (!INSTANCE_MODES.includes(instances)) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`instances\` must be ${INSTANCE_MODES.map((mode) => `"${mode}"`).join(" or ")}, but it's ${JSON.stringify(instances)}.`,
    );
  }
  const outbound =
    options.outbound === undefined
      ? undefined
      : { allow: createOutboundPolicy(options.outbound).allow };
  const experimental = options.experimental ?? {};
  if (typeof experimental !== "object" || experimental === null) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`experimental\` must be an object, but it's ${JSON.stringify(experimental)}.`,
    );
  }
  const runtime = experimental.runtime ?? "jco";
  if (!RUNTIMES.includes(runtime)) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`experimental.runtime\` must be ${RUNTIMES.map((name) => `"${name}"`).join(" or ")}, but it's ${JSON.stringify(runtime)}.`,
    );
  }
  return { instances, outbound, runtime };
}

const RUNTIME_ID = "@farming-labs/polyroute/runtime";
const WASMTIME_RUNTIME_ID = "@farming-labs/polyroute/runtime/wasmtime";
const BINDINGS_ID = "virtual:polyroute/bindings/";
const RESOLVED_BINDINGS_ID = `\0${BINDINGS_ID}`;
const ROUTE_FILE = new RegExp(
  `\\.(?:${LANGUAGES.flatMap((language) => language.extensions.map((extension) => extension.slice(1))).join("|")})(?:\\?.*)?$`,
);
// Vite's own asset queries, such as `route.rs?raw` or `module.wasm?init`.
const VITE_QUERY = /[?&](?:raw|url|init|inline|no-inline|worker|sharedworker)(?:[&=]|$)/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function runtimeEntry(name: "index" | "wasmtime"): string {
  const built = fileURLToPath(new URL(`./runtime/${name}.js`, import.meta.url));
  return existsSync(built)
    ? built
    : fileURLToPath(new URL(`./runtime/${name}.ts`, import.meta.url));
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Where a build writes a core module, relative to the chunk that loads it. */
function coreModuleFile(key: string, name: string): string {
  return `polyroute/${key}/${name}`;
}

/** Where a build writes a route's machine code, relative to the chunk that loads it. */
function machineCodeFile(route: PrecompiledRoute): string {
  return `polyroute/${route.key}/${route.target}.cwasm`;
}

/** Where a build writes the wasmtime addon, relative to the chunk that loads it. */
function addonFile(target: string): string {
  return `polyroute/wasmtime/${target}.node`;
}

const ROUTE_EXPORTS = [
  "export default route;",
  "export const fetch = route.fetch;",
  ...METHODS.map((method) => `export const ${method} = route.fetch;`),
  "",
];

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
  outbound?: OutboundOptions,
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
    ...(outbound === undefined ? [] : [`  outbound: ${JSON.stringify(outbound)},`]),
    "  instantiate,",
    "  coreModules: {",
    coreModules,
    "  },",
    "});",
    "",
    ...ROUTE_EXPORTS,
  ].join("\n");
}

/** The module a route file compiles to when wasmtime runs it. */
export function createWasmtimeRouteModule(
  label: string,
  precompiled: PrecompiledRoute,
  instances: InstanceMode,
  requestsPerInstance?: number,
): string {
  const url = (file: string) => `new URL(${JSON.stringify(`./${file}`)}, import.meta.url)`;
  return [
    `import { createWasmtimeHandler } from ${JSON.stringify(WASMTIME_RUNTIME_ID)};`,
    "",
    "const route = createWasmtimeHandler({",
    `  route: ${JSON.stringify(label)},`,
    `  instances: ${JSON.stringify(instances)},`,
    ...(requestsPerInstance === undefined
      ? []
      : [`  requestsPerInstance: ${JSON.stringify(requestsPerInstance)},`]),
    `  target: ${JSON.stringify(precompiled.target)},`,
    `  addon: ${url(addonFile(precompiled.target))},`,
    `  component: ${url(machineCodeFile(precompiled))},`,
    "});",
    "",
    ...ROUTE_EXPORTS,
  ].join("\n");
}

/**
 * Builds route files written in other languages into modules that export a
 * web-standard fetch handler.
 */
export function polyroute(options: PolyrouteOptions = {}): Plugin {
  const { instances, outbound, runtime } = resolveOptions(options);
  let config: ResolvedConfig;
  const bindings = new Map<string, string>();
  // Route modules a build loads, by module ID, so their core modules can be
  // written next to whichever chunk each one ends up in.
  const builtRoutes = new Map<string, TranspiledRoute | PrecompiledRoute>();

  return {
    name: "polyroute",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
      if (runtime === "wasmtime" && config.command === "serve") {
        config.logger.info(
          'polyroute: `experimental.runtime: "wasmtime"` applies to `vite build`. Dev serves routes with jco.',
        );
      }
    },

    resolveId: {
      filter: {
        id: [/^@farming-labs\/polyroute\/runtime(?:\/wasmtime)?$/, /^virtual:polyroute\//],
      },
      handler(id) {
        if (id === RUNTIME_ID) return runtimeEntry("index");
        if (id === WASMTIME_RUNTIME_ID) return runtimeEntry("wasmtime");
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
        if (transpiled.outbound && outbound === undefined) {
          throw new PolyrouteError(
            "OUTBOUND_NOT_ALLOWED",
            `\`${label}\` sends HTTP requests (it imports \`wasi:http/outgoing-handler\`), and polyroute allows none by default. List the hosts routes may call, for example \`polyroute({ outbound: { allow: ["api.example.com"] } })\`.`,
          );
        }
        bindings.set(transpiled.key, transpiled.bindings);
        config.logger.info(
          `polyroute: built ${label} (${(wasm.byteLength / 1024).toFixed(0)} KiB) in ${Math.round(performance.now() - started)} ms`,
          { timestamp: true },
        );
        if (runtime === "wasmtime" && config.command === "build") {
          if (transpiled.outbound) {
            throw new PolyrouteError(
              "UNSUPPORTED_RUNTIME",
              `\`${label}\` sends HTTP requests (it imports \`wasi:http/outgoing-handler\`), which \`experimental.runtime: "wasmtime"\` doesn't support yet. Build it with the default runtime.`,
            );
          }
          const precompiled = await precompileRoute(wasm, label, cacheDir);
          builtRoutes.set(id, precompiled);
          return createWasmtimeRouteModule(
            label,
            precompiled,
            instances,
            language.requestsPerInstance,
          );
        }
        const coreModuleFiles = config.command === "build";
        if (coreModuleFiles) builtRoutes.set(id, transpiled);
        return createRouteModule(
          label,
          transpiled,
          instances,
          language.requestsPerInstance,
          coreModuleFiles,
          transpiled.outbound ? outbound : undefined,
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
          const emit = (file: string, source: () => Uint8Array) => {
            const fileName = path.posix.join(dir, file);
            if (emitted.has(fileName)) return;
            emitted.add(fileName);
            this.emitFile({ type: "asset", fileName, source: source() });
          };
          for (const id of chunk.moduleIds) {
            const built = builtRoutes.get(id);
            if (built === undefined) continue;
            if ("file" in built) {
              emit(machineCodeFile(built), () => readFileSync(built.file));
              emit(addonFile(built.target), () => readFileSync(built.addonFile));
              continue;
            }
            for (const [name, encoded] of Object.entries(built.coreModules)) {
              emit(coreModuleFile(built.key, name), () => Buffer.from(encoded, "base64"));
            }
          }
        }
      },
    },
  };
}
