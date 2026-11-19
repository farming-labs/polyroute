import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { python } from "../src/languages/python.js";
import { transpileRoute, type TranspiledRoute } from "../src/transpile.js";
import { fixturesDir } from "./helpers.js";

let cacheDir: string;
let nativeWasm: Uint8Array;
let native: TranspiledRoute;
let portable: TranspiledRoute;
const label = "python/response/route.py";

beforeAll(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "polyroute-python-native-"));
  const input = {
    routeFile: path.join(fixturesDir, label),
    label,
    cacheDir,
  };
  nativeWasm = (await python.build({ ...input, runtime: "wasmtime" })).wasm;
  native = await transpileRoute(nativeWasm, label, cacheDir, python.handlerHint, "wasmtime");
  const built = await python.build(input);
  portable = await transpileRoute(built.wasm, label, cacheDir, python.handlerHint);
});
afterAll(async () => {
  if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true });
});

it("keeps native imports and their cache entries out of the portable build", async () => {
  expect(native.bindings).toContain("polyroute:route/native-http");
  expect(portable.bindings).not.toContain("polyroute:route/native-http");
  expect(portable.key).not.toBe(native.key);
  await expect(
    transpileRoute(nativeWasm, label, cacheDir, python.handlerHint),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_IMPORT" });
});
