import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The addon binary, which a build copies next to the server bundle. */
export const addonPath = fileURLToPath(new URL("./polyroute-wasmtime.node", import.meta.url));
const compilerPath = fileURLToPath(new URL("./polyroute-wasmtime-compiler.node", import.meta.url));

let addon;

/** Loads the build-time addon. The server receives only `addonPath`. */
export function loadAddon() {
  addon ??= createRequire(import.meta.url)(compilerPath);
  return addon;
}
