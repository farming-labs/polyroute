import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRouteProcess } from "../packages/polyroute/test/route-process.mjs";

test("route process preserves responses, errors, and reuse until it exits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "polyroute-process-test-"));
  const file = path.join(directory, "route.mjs");
  await writeFile(
    file,
    `let count = 0;
export const echo = {
  route: "echo/route.rs",
  async fetch(request) {
    count++;
    if (new URL(request.url).pathname === "/panic") {
      throw Object.assign(new Error("fixture trap"), { name: "PolyrouteError", code: "ROUTE_TRAPPED" });
    }
    return new Response(request.method === "HEAD" ? null : await request.arrayBuffer(), {
      status: 201,
      headers: { "x-count": String(count), "x-echo": request.headers.get("x-echo") ?? "" },
    });
  },
};`,
  );
  const server = createRouteProcess();
  try {
    const { echo } = await server.load(file);
    assert.equal(echo.route, "echo/route.rs");
    const response = await echo.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "x-echo": "hello" },
        body: new Uint8Array([0, 255, 128, 10]),
      }),
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-count"), "1");
    assert.equal(response.headers.get("x-echo"), "hello");
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new Uint8Array([0, 255, 128, 10]),
    );
    const head = await echo.fetch(new Request("http://localhost/", { method: "HEAD" }));
    assert.equal(head.body, null);
    assert.equal(head.headers.get("x-count"), "2");
    await assert.rejects(echo.fetch(new Request("http://localhost/panic")), {
      name: "PolyrouteError",
      code: "ROUTE_TRAPPED",
      message: "fixture trap",
    });
    const after = await echo.fetch(new Request("http://localhost/"));
    assert.equal(after.headers.get("x-count"), "4");
  } finally {
    await server.close();
    await rm(directory, { recursive: true });
  }
  await server.close();
  await assert.rejects(server.load(file), /The route process is closed/);
});

test("a failed module import is reported and retried", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "polyroute-process-import-"));
  const file = path.join(directory, "route.mjs");
  const server = createRouteProcess();
  try {
    await assert.rejects(server.load(file), { code: "ERR_MODULE_NOT_FOUND" });
    await writeFile(
      file,
      "export const echo = { route: 'echo', fetch: () => new Response('ok') };",
    );
    const { echo } = await server.load(file);
    assert.equal(await (await echo.fetch(new Request("http://localhost/"))).text(), "ok");
  } finally {
    await server.close();
    await rm(directory, { recursive: true });
  }
});
