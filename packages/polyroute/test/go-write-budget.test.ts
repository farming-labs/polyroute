import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { buildServerEntry } from "./helpers.js";
import { createRouteProcess } from "./route-process.mjs";

describe.each(["jco", "wasmtime"] as const)("Go response write budget in %s", (runtime) => {
  const server = createRouteProcess();
  let output: string;
  let route: WasiHttpRoute;

  beforeAll(async () => {
    output = await mkdtemp(path.join(tmpdir(), "polyroute-go-write-budget-"));
    const entry = await buildServerEntry("go-write-entry.ts", output, undefined, {
      experimental: { runtime },
    });
    route = ((await server.load(entry.file)) as { go: WasiHttpRoute }).go;
  });

  afterAll(async () => {
    await server.close();
    await rm(output, { recursive: true, force: true });
  });

  it.each([0, 4095, 4096, 4097, 1_048_576, 1_048_577])(
    "returns every byte when the request body has %i bytes",
    async (length) => {
      const body = Uint8Array.from({ length }, (_, index) => index % 256);
      const response = await route.fetch(
        new Request("http://localhost/write-budget?check=1", {
          method: "POST",
          headers: { "x-greeting": "budget" },
          body,
        }),
      );
      expect(response.status).toBe(201);
      expect(response.headers.get("x-served-by")).toBe("go");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const prefix = Buffer.from(
        "method=POST\npath=/write-budget?check=1\ngreeting=budget\nhello from a second file in the package\nbody=",
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.concat([prefix, body, Buffer.from("\n")]),
      );
    },
  );

  it("keeps serving after the boundary checks", async () => {
    const response = await route.fetch(new Request("http://localhost/after-write"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("path=/after-write\n");
  });
});
