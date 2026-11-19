import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { buildServerEntry } from "./helpers.js";
import { createRouteProcess } from "./route-process.mjs";

const expectedBody = '{"text":"\\u2603","numbers":[1,1.25,true,null]}';

describe.each([
  { runtime: "jco", instances: "reuse" },
  { runtime: "jco", instances: "per-request" },
  { runtime: "wasmtime", instances: "reuse" },
  { runtime: "wasmtime", instances: "per-request" },
] as const)("$runtime Python responses ($instances)", ({ runtime, instances }) => {
  const server = createRouteProcess();
  let outDir: string;
  let route: WasiHttpRoute;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "polyroute-python-response-"));
    const built = await buildServerEntry(
      "python-response-entry.ts",
      path.join(outDir, "server"),
      undefined,
      { experimental: { runtime }, instances },
    );
    const routes = (await server.load(built.file)) as { python: WasiHttpRoute };
    route = routes.python;
  });

  afterAll(async () => {
    await server.close();
    if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
  });

  const request = (testCase = "default") =>
    route.fetch(new Request(`http://localhost/?case=${testCase}`));

  it.each([
    ["default", 200],
    ["created", 201],
    ["subclass", 200],
  ] as const)("preserves %s status and compact JSON bytes", async (testCase, status) => {
    const response = await request(testCase);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(expectedBody);
  });

  it("preserves custom content types and both forms of iterable headers", async () => {
    const mapping = await request("mapping");
    expect(mapping.headers.get("content-type")).toBe("custom/test");
    expect(mapping.headers.get("x-probe")).toBe("one");
    const cookies = await request("cookies");
    expect(cookies.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const generator = await request("generator");
    expect(generator.headers.get("x-0")).toBe("0");
    expect(generator.headers.get("x-1")).toBe("1");
  });

  it.each(["cycle", "object"])("encodes again after a %s JSON error", async (testCase) => {
    expect(await (await request(testCase)).json()).toEqual({ recovered: true });
    expect(await (await request()).text()).toBe(expectedBody);
  });

  it.each(["float", "negative", "huge", "string"])(
    "rejects a %s status and serves the next request",
    async (testCase) => {
      await expect(request(testCase)).rejects.toMatchObject({ code: "ROUTE_TRAPPED" });
      expect(await (await request()).text()).toBe(expectedBody);
    },
  );

  it("keeps JSON encoding state separate across queued requests", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => request()));
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array.from({ length: 12 }, () => expectedBody),
    );
  });

  it("preserves request metadata and Latin-1 headers", async () => {
    const url = "https://example.test/a%20b?case=request&q=one&q=two&blank=";
    const response = await route.fetch(
      new Request(url, {
        headers: [
          ["x-probe", "one"],
          ["x-probe", "two"],
          ["x-latin", "café"],
        ],
      }),
    );
    expect(await response.json()).toEqual({
      method: "GET",
      url,
      path: "/a%20b",
      query: { case: "request", q: "two", blank: "" },
      headers: { "x-probe": "one, two", "x-latin": "café" },
    });
    expect((await request("latin1")).headers.get("x-probe")).toBe("café");
  });

  it.each([0, 1, 4095, 4096, 4097, 65535, 65536, 65537, 1048576])(
    "preserves a %i-byte binary request and response",
    async (size) => {
      const body = Uint8Array.from({ length: size }, (_, index) => index % 256);
      const response = await route.fetch(
        new Request("http://localhost/body", { method: "POST", body }),
      );
      expect(response.headers.get("x-method")).toBe("POST");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    },
  );

  it("keeps retained request data owned by its handler", async () => {
    for (let index = 0; index < 4; index++) {
      const response = await route.fetch(
        new Request(`http://localhost/?case=retain&index=${index}`, {
          method: "POST",
          body: `owned request ${index}`,
        }),
      );
      const retainedIndex = instances === "reuse" ? 0 : index;
      expect(await response.text()).toBe(`owned request ${retainedIndex}`);
      expect(response.headers.get("x-url")).toBe(
        `http://localhost/?case=retain&index=${retainedIndex}`,
      );
    }
  });

  it("keeps HEAD and method-not-allowed behavior", async () => {
    const head = await route.fetch(new Request("http://localhost/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const denied = await route.fetch(new Request("http://localhost/", { method: "PATCH" }));
    expect(denied.status).toBe(405);
    expect(denied.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it.each(["header-name", "header-value", "forbidden"])(
    "rejects %s headers and serves the next request",
    async (testCase) => {
      await expect(request(testCase)).rejects.toMatchObject({ code: "ROUTE_TRAPPED" });
      expect(await (await request()).text()).toBe(expectedBody);
    },
  );

  if (runtime === "wasmtime") {
    it.each(["short", "long", "length"])(
      "preserves native %s content-length validation",
      async (testCase) => {
        await expect(request(testCase)).rejects.toMatchObject({ code: "ROUTE_TRAPPED" });
        expect(await (await request()).text()).toBe(expectedBody);
      },
    );
  }
});
