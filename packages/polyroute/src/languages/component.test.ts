import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isComponent } from "./component.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "polyroute-component-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileWith(name: string, bytes: number[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, new Uint8Array(bytes));
  return file;
}

describe("isComponent", () => {
  it("accepts the component preamble", async () => {
    const file = await fileWith("component.wasm", [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
    expect(await isComponent(file)).toBe(true);
  });

  it("rejects a core module so Vite can handle it", async () => {
    const file = await fileWith("core.wasm", [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(await isComponent(file)).toBe(false);
  });

  it("rejects a file that is too short or isn't Wasm", async () => {
    expect(await isComponent(await fileWith("short.wasm", [0x00, 0x61, 0x73]))).toBe(false);
    expect(await isComponent(await fileWith("text.wasm", [...Buffer.from("not wasm")]))).toBe(
      false,
    );
  });
});
