import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { transpileBytes } from "@bytecodealliance/jco-transpile";
import { PolyrouteError } from "./errors.js";
import {
  HTTP_HANDLER_INTERFACE,
  SUPPORTED_INTERFACES,
  isSupportedVersion,
  parseInterfaceName,
} from "./interfaces.js";

/** Bump when the cached output format or the codegen contract changes. */
const CACHE_FORMAT = 3;

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

export interface TranspiledRoute {
  /** Content hash of the component and the transpiler, used as the cache key. */
  key: string;
  /** jco's `instantiate` module. */
  bindings: string;
  /** Core Wasm modules, base64-encoded, keyed by the name `instantiate` asks for. */
  coreModules: Record<string, string>;
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
  try {
    result = await transpileBytes(wasm, {
      name: "route",
      instantiation: "async",
      emitTypescriptDeclarations: false,
    });
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
      bindings = readJcoDebugOnce(decoder.decode(bytes).replace(COMPONENT_DIRECTIVE, ""));
    } else if (name.endsWith(".wasm")) coreModules[name] = Buffer.from(bytes).toString("base64");
  }
  if (bindings === undefined) {
    throw new PolyrouteError("BUILD_FAILED", `jco produced no bindings for \`${label}\`.`);
  }

  const entry = { bindings, coreModules };
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
    `\`${label}\` imports ${list}, which polyroute's embedded runtime doesn't provide. Routes can use stdout and stderr, clocks, random numbers, and \`wasi:http/types\`, and the filesystem and sockets are linked with nothing behind them. Outbound HTTP isn't available yet, so remove the code that needs it.`,
  );
}
