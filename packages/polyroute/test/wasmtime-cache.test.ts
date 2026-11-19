import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAddon } from "@farming-labs/polyroute-wasmtime";
import { expect, it } from "vitest";
import { precompileRoute } from "../src/wasmtime.js";

it("recompiles the previous host-tuned cache without overwriting it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "polyroute-cpu-cache-"));
  try {
    const component = new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]);
    const addon = loadAddon();
    const { target, wasmtime } = addon.info();
    const previousKey = createHash("sha256")
      .update(`1\0${wasmtime}\0${target}\0`)
      .update(component)
      .digest("hex")
      .slice(0, 32);
    const previous = path.join(directory, "cwasm", `${previousKey}.cwasm`);
    await mkdir(path.dirname(previous));
    await writeFile(previous, "previous host-tuned artifact");

    const result = await precompileRoute(component, "empty component", directory);
    expect(result.file).not.toBe(previous);
    expect(await readFile(previous, "utf8")).toBe("previous host-tuned artifact");
    expect(await readFile(result.file)).toEqual(Buffer.from(addon.precompile(component)));
  } finally {
    await rm(directory, { recursive: true });
  }
});
