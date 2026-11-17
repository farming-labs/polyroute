import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The addon binary, which a build copies next to the server bundle. */
export const addonPath = fileURLToPath(new URL("./polyroute-wasmtime.node", import.meta.url));

let addon;

export function loadAddon() {
  addon ??= createRequire(import.meta.url)(addonPath);
  return addon;
}
