import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PolyrouteError } from "./errors.js";

/** Bump when the cached machine code's format, naming, or compiler settings change. */
const CACHE_FORMAT = 2;
const ADDON_PACKAGE = "@farming-labs/polyroute-wasmtime";

interface Addon {
  info(): { target: string; wasmtime: string };
  precompile(component: Uint8Array): Uint8Array;
}

interface AddonPackage {
  addonPath: string;
  loadAddon(): Addon;
}

export interface PrecompiledRoute {
  /** Hash of the component, the wasmtime version, and the target. */
  key: string;
  /** The Rust target triple the machine code runs on. */
  target: string;
  /** The cached machine code. */
  file: string;
  /** The matching compiler-free addon the server loads it with. */
  addonFile: string;
}

let addonPackage: Promise<{ addonPath: string; addon: Addon }> | undefined;

function loadAddonPackage(): Promise<{ addonPath: string; addon: Addon }> {
  addonPackage ??= (async () => {
    let loaded: AddonPackage;
    try {
      loaded = (await import(ADDON_PACKAGE)) as AddonPackage;
    } catch (error) {
      throw new PolyrouteError(
        "RUNTIME_UNAVAILABLE",
        `\`experimental.runtime: "wasmtime"\` needs the \`${ADDON_PACKAGE}\` package next to polyroute, and it couldn't be imported (${error instanceof Error ? error.message : String(error)}). Add it to the app's dependencies, or remove \`experimental.runtime\`.`,
        { cause: error },
      );
    }
    try {
      await access(loaded.addonPath);
      return { addonPath: loaded.addonPath, addon: loaded.loadAddon() };
    } catch (error) {
      throw new PolyrouteError(
        "RUNTIME_UNAVAILABLE",
        `\`experimental.runtime: "wasmtime"\` needs \`${ADDON_PACKAGE}\` built for this machine (${process.platform} ${process.arch}), and its addon didn't load (${error instanceof Error ? error.message : String(error)}). Build it with \`pnpm --filter ${ADDON_PACKAGE} build\`.`,
        { cause: error },
      );
    }
  })();
  // A failed load isn't kept, so the next route tries again.
  addonPackage.catch(() => {
    addonPackage = undefined;
  });
  return addonPackage;
}

/**
 * Compiles a route's component to this OS/architecture's baseline machine code with the
 * compiler that matches the server's runtime addon. The result is cached, since compiling
 * a Go or Python route takes seconds.
 */
export async function precompileRoute(
  wasm: Uint8Array,
  label: string,
  cacheDir: string,
): Promise<PrecompiledRoute> {
  const { addonPath, addon } = await loadAddonPackage();
  const { target, wasmtime } = addon.info();
  const key = createHash("sha256")
    .update(`${CACHE_FORMAT}\0${wasmtime}\0${target}\0`)
    .update(wasm)
    .digest("hex")
    .slice(0, 32);
  const file = path.join(cacheDir, "cwasm", `${key}.cwasm`);
  const cached = await readFile(file).catch(() => undefined);
  if (cached === undefined) {
    let compiled: Uint8Array;
    try {
      compiled = addon.precompile(wasm);
    } catch (error) {
      throw new PolyrouteError(
        "BUILD_FAILED",
        `wasmtime couldn't compile \`${label}\`: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await mkdir(path.dirname(file), { recursive: true });
    // Write then rename so a concurrent build never reads a partial file.
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, compiled);
    await rename(temporary, file);
  }
  return { key, target, file, addonFile: addonPath };
}
