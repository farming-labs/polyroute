import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { transpileBytes } from "@bytecodealliance/jco-transpile";
import { PolyrouteError } from "./errors.js";
import {
  HTTP_HANDLER_INTERFACE,
  OUTGOING_HANDLER_INTERFACE,
  SUPPORTED_INTERFACES,
  isSupportedVersion,
  parseInterfaceName,
} from "./interfaces.js";
import { skipSyncTaskBookkeeping } from "./sync-imports.js";

/** Bump when the cached output format or the codegen contract changes. */
const CACHE_FORMAT = 6;

// A route that sends outbound requests waits for responses in these imports.
// JSPI lets them return a promise: V8 suspends the guest's stack, and resumes
// it once the promise settles, while the event loop keeps running.
const SUSPENDING_IMPORTS = ["wasi:io/poll#poll", "wasi:io/poll#[method]pollable.block"];
const SUSPENDING_EXPORTS = [`${HTTP_HANDLER_INTERFACE}#handle`];

// jco marks its output with this directive. It has no meaning to JavaScript
// engines, and bundlers warn that they can't preserve it.
const COMPONENT_DIRECTIVE = /^\s*["']use components["'];?[ \t]*\r?\n?/;

// jco's runtime checks this before each of the debug logs it makes on every
// call between the host and the guest. Reading `process.env` is a native call
// in Node, so the bindings read it once, when the route's module loads.
const JCO_DEBUG_READ = "globalThis?.process?.env?.JCO_DEBUG";
const JCO_DEBUG_FLAG = "__polyrouteJcoDebug";

function readJcoDebugOnce(bindings: string): string {
  if (!bindings.includes(JCO_DEBUG_READ)) return bindings;
  const body = bindings.replaceAll(JCO_DEBUG_READ, JCO_DEBUG_FLAG);
  return `const ${JCO_DEBUG_FLAG} = Boolean(${JCO_DEBUG_READ});\n${body}`;
}

// jco adds the rep of every resource it hands the guest to a Set on that
// resource's handle table, and nothing reads or empties it. Reps come from
// counters that only go up, so a reused instance's Sets grow by 9 to 11 entries
// a request: about 90 MB after 400,000 requests to the example's Rust route.
// The busiest Set gains 2 entries a request, so after about 8.4 million it would
// reach V8's limit of 2^24 entries, past which `Set.add` throws. The bindings
// skip the `add` when the Sets have no other use.
const CREATED_REPS = /\b_createdReps\b/g;
const CREATED_REPS_TABLE = /\b\w+\._createdReps = new Set\(\);/g;
const CREATED_REPS_ADD = "\ttable._createdReps.add(rep);\n";

function skipCreatedRepsSet(bindings: string): string {
  const uses = bindings.match(CREATED_REPS)?.length ?? 0;
  const tables = bindings.match(CREATED_REPS_TABLE)?.length ?? 0;
  const adds = bindings.split(CREATED_REPS_ADD).length - 1;
  if (adds !== 1 || uses !== tables + 1) return bindings;
  return bindings.replace(CREATED_REPS_ADD, "");
}

export interface TranspiledRoute {
  /** Content hash of the component and the transpiler, used as the cache key. */
  key: string;
  /** jco's `instantiate` module. */
  bindings: string;
  /** Core Wasm modules, base64-encoded, keyed by the name `instantiate` asks for. */
  coreModules: Record<string, string>;
  /**
   * Whether the route imports `wasi:http/outgoing-handler`. Such a route is
   * transpiled with JSPI, and its `handle` export returns a promise.
   */
  outbound: boolean;
}

const supported: ReadonlySet<string> = new Set(SUPPORTED_INTERFACES);
let transpilerVersion: string | undefined;

function getTranspilerVersion(): string {
  if (transpilerVersion === undefined) {
    const entry = createRequire(import.meta.url).resolve("@bytecodealliance/jco-transpile");
    const manifest = path.join(path.dirname(entry), "..", "package.json");
    transpilerVersion = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  }
  return transpilerVersion;
}

export async function transpileRoute(
  wasm: Uint8Array,
  label: string,
  cacheDir: string,
  handlerHint: string,
): Promise<TranspiledRoute> {
  const key = createHash("sha256")
    .update(`${CACHE_FORMAT}\0${getTranspilerVersion()}\0`)
    .update(wasm)
    .digest("hex")
    .slice(0, 32);
  const cacheFile = path.join(cacheDir, "transpiled", `${key}.json`);

  const cached = await readFile(cacheFile, "utf8").catch(() => undefined);
  if (cached !== undefined) return { key, ...(JSON.parse(cached) as Omit<TranspiledRoute, "key">) };

  let result: Awaited<ReturnType<typeof transpileBytes>>;
  let outbound = false;
  try {
    const options = {
      name: "route",
      instantiation: "async",
      emitTypescriptDeclarations: false,
    } as const;
    result = await transpileBytes(wasm, options);
    // jco reports a component's imports only after transpiling it, so a route
    // that sends requests is transpiled a second time, with JSPI.
    outbound = result.imports.some(
      (name) => parseInterfaceName(name).name === OUTGOING_HANDLER_INTERFACE,
    );
    if (outbound) {
      result = await transpileBytes(wasm, {
        ...options,
        asyncMode: "jspi",
        asyncImports: SUSPENDING_IMPORTS,
        asyncExports: SUSPENDING_EXPORTS,
      });
    }
  } catch (error) {
    throw new PolyrouteError(
      "BUILD_FAILED",
      `jco couldn't transpile \`${label}\`: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  checkExports(result.exports, label, handlerHint);
  checkImports(result.imports, label);

  const decoder = new TextDecoder();
  let bindings: string | undefined;
  const coreModules: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(result.files)) {
    if (name === "route.js") {
      const source = readJcoDebugOnce(decoder.decode(bytes).replace(COMPONENT_DIRECTIVE, ""));
      bindings = skipCreatedRepsSet(skipSyncTaskBookkeeping(source).bindings);
    } else if (name.endsWith(".wasm")) coreModules[name] = Buffer.from(bytes).toString("base64");
  }
  if (bindings === undefined) {
    throw new PolyrouteError("BUILD_FAILED", `jco produced no bindings for \`${label}\`.`);
  }

  const entry = { bindings, coreModules, outbound };
  await mkdir(path.dirname(cacheFile), { recursive: true });
  // Write then rename so a concurrent reader never sees a partial file.
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entry));
  await rename(temporary, cacheFile);
  return { key, ...entry };
}

function checkExports(exports: Array<[string, string]>, label: string, hint: string): void {
  const handler = exports
    .map(([name]) => parseInterfaceName(name))
    .find((name) => name.name === HTTP_HANDLER_INTERFACE && isSupportedVersion(name.version));
  if (handler === undefined) {
    throw new PolyrouteError(
      "MISSING_HANDLER",
      `\`${label}\` doesn't export a \`${HTTP_HANDLER_INTERFACE}@0.2\` handler. ${hint}`,
    );
  }
}

function checkImports(imports: string[], label: string): void {
  const missing = imports
    .map((name) => parseInterfaceName(name).name)
    .filter((name) => !supported.has(name));
  if (missing.length === 0) return;
  const list = missing.map((name) => `\`${name}\``).join(", ");
  throw new PolyrouteError(
    "UNSUPPORTED_IMPORT",
    `\`${label}\` imports ${list}, which polyroute's embedded runtime doesn't provide. Routes can use stdout and stderr, clocks, random numbers, \`wasi:http/types\`, and \`wasi:http/outgoing-handler\`, and the filesystem and sockets are linked with nothing behind them. Remove the code that needs the rest.`,
  );
}
