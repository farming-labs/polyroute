import { open, readFile } from "node:fs/promises";
import type { Language } from "./types.js";

/**
 * True when the file starts with the component preamble: the `\0asm` magic,
 * version 0x0d, and layer 1. Core modules use version 1 and layer 0.
 */
export async function isComponent(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const header = new Uint8Array(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return (
      bytesRead === header.length &&
      header[0] === 0x00 &&
      header[1] === 0x61 &&
      header[2] === 0x73 &&
      header[3] === 0x6d &&
      header[6] === 0x01 &&
      header[7] === 0x00
    );
  } finally {
    await handle.close();
  }
}

/**
 * A component built ahead of time, in any language. Core Wasm modules are left
 * to Vite and other plugins.
 */
export const component: Language = {
  name: "WebAssembly component",
  extensions: [".wasm"],
  handlerHint:
    "Build the component for the `wasi:http/proxy` world, so that it exports `wasi:http/incoming-handler`.",
  accepts: isComponent,
  async build({ routeFile }) {
    return { wasm: await readFile(routeFile), sources: [routeFile] };
  },
};
