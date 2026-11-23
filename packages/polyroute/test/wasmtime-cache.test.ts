import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAddon } from "@farming-labs/polyroute-wasmtime";
import { expect, it } from "vitest";
import { precompileRoute } from "../src/wasmtime.js";

// Format 1 was tuned to the compiling machine's CPU. Format 2 carried an
// address map and a symbol table, and engines that load without them reject it.
it.each([
  [1, "previous host-tuned artifact"],
  [2, "previous artifact with an address map and symbols"],
])("recompiles cache format %i without overwriting it", async (format, contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), "polyroute-cpu-cache-"));
  try {
    const component = new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]);
    const addon = loadAddon();
    const { target, wasmtime } = addon.info();
    const previousKey = createHash("sha256")
      .update(`${format}\0${wasmtime}\0${target}\0`)
      .update(component)
      .digest("hex")
      .slice(0, 32);
    const previous = path.join(directory, "cwasm", `${previousKey}.cwasm`);
    await mkdir(path.dirname(previous));
    await writeFile(previous, contents);

    const result = await precompileRoute(component, "empty component", directory);
    expect(result.file).not.toBe(previous);
    expect(await readFile(previous, "utf8")).toBe(contents);
    expect(await readFile(result.file)).toEqual(Buffer.from(addon.precompile(component)));
  } finally {
    await rm(directory, { recursive: true });
  }
});
