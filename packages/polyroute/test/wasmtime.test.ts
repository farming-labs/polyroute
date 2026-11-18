import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { polyroute } from "../src/index.js";
import { GO_REQUESTS_PER_INSTANCE } from "../src/languages/go.js";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { buildServerEntry, type BuiltEntry } from "./helpers.js";
import { createRouteProcess } from "./route-process.mjs";

// The same fixtures as build.test.ts, built with `experimental.runtime:
// "wasmtime"`. These tests need the addon: `pnpm --filter
// @farming-labs/polyroute-wasmtime build`.

const wasmtime = { experimental: { runtime: "wasmtime" } } as const;

interface ServerEntry {
  echo: WasiHttpRoute;
  panic: WasiHttpRoute;
  crate: WasiHttpRoute;
  python: WasiHttpRoute;
  pythonRaise: WasiHttpRoute;
  go: WasiHttpRoute;
  goPanic: WasiHttpRoute;
  counter: WasiHttpRoute;
  goCounter: WasiHttpRoute;
}

async function count(route: WasiHttpRoute, path = "/"): Promise<number> {
  return Number(await (await route.fetch(new Request(`http://localhost${path}`))).text());
}

let outDir: string;
let built: BuiltEntry;
let routes: ServerEntry;
const server = createRouteProcess();

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "polyroute-wasmtime-"));
  built = await buildServerEntry(
    "server-entry.ts",
    path.join(outDir, "server"),
    undefined,
    wasmtime,
  );
  routes = (await server.load(built.file)) as ServerEntry;
});

afterAll(async () => {
  await server.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('experimental.runtime: "wasmtime" build', () => {
  it("bundles the runtime so the output imports nothing but node: builtins", () => {
    expect(built.code).not.toMatch(/^\s*import\s[^;]*?from\s*["'](?!node:)/m);
    expect(built.code).not.toMatch(/\bimport\(\s*["'](?!node:)/);
  });

  it("writes each route's machine code and the addon next to the bundle, and nothing of jco's", async () => {
    expect(built.code).not.toMatch(/"[A-Za-z0-9+/]{4096,}={0,2}"/);
    expect(built.code).not.toMatch(/_trampoline\d+/);
    const referenced = [
      ...built.code.matchAll(/new URL\("\.\/(polyroute\/[^"]+)", import\.meta\.url\)/g),
    ].map((match) => match[1]);
    const root = path.dirname(built.file);
    const written = (
      await readdir(path.join(root, "polyroute"), { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .map((file) => file.split(path.sep).join("/"));
    expect(written.sort()).toEqual([...new Set(referenced)].sort());
    const machineCode = written.filter((file) => file.endsWith(".cwasm"));
    const addons = written.filter((file) => file.endsWith(".node"));
    // Nine routes, each its own component.
    expect(machineCode).toHaveLength(9);
    expect(addons).toEqual([expect.stringMatching(/^polyroute\/wasmtime\/[\w-]+\.node$/)]);
    for (const file of machineCode) {
      // Machine code, not a component: wasmtime writes it as a native object.
      expect(WebAssembly.validate(await readFile(path.join(root, file)))).toBe(false);
    }
  });
});

describe("Rust routes in wasmtime", () => {
  it("serves a GET with the path, query, and request headers", async () => {
    const response = await routes.echo.fetch(
      new Request("http://localhost/api/echo?name=farm", { headers: { "x-greeting": "selam" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-served-by")).toBe("rust");
    expect(await response.text()).toBe(
      "method=GET\npath=/api/echo?name=farm\ngreeting=selam\nbody=\n",
    );
  });

  it("passes the request body through and returns the route's status", async () => {
    const response = await routes.echo.fetch(
      new Request("http://localhost/api/echo", { method: "POST", body: "hello from js" }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(
      "method=POST\npath=/api/echo\ngreeting=none\nbody=hello from js\n",
    );
  });

  it("sends no body for HEAD but keeps the headers", async () => {
    const response = await routes.echo.fetch(
      new Request("http://localhost/api/echo", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-served-by")).toBe("rust");
    expect(response.body).toBeNull();
  });

  it("serves a route that has its own Cargo.toml and several modules", async () => {
    const response = await routes.crate.fetch(new Request("http://localhost/"));
    expect(await response.text()).toBe("hello from a crate with its own Cargo.toml");
  });

  it("turns a panic into a ROUTE_TRAPPED error that carries the panic message", async () => {
    await expect(
      routes.panic.fetch(new Request("http://localhost/api/panic")),
    ).rejects.toMatchObject({
      name: "PolyrouteError",
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining("fixture route panicked on purpose"),
    });
  });

  it("keeps serving other routes after one traps", async () => {
    await expect(routes.panic.fetch(new Request("http://localhost/"))).rejects.toThrow();
    const response = await routes.echo.fetch(new Request("http://localhost/after-panic"));
    expect(await response.text()).toContain("path=/after-panic\n");
  });
});

describe("reused instances in wasmtime", () => {
  it("serves every request from one instance, so global state persists", async () => {
    const first = await count(routes.counter);
    expect([await count(routes.counter), await count(routes.counter)]).toEqual([
      first + 1,
      first + 2,
    ]);
  });

  it("throws away an instance that trapped, so the next request starts fresh", async () => {
    await count(routes.counter);
    await expect(routes.counter.fetch(new Request("http://localhost/panic"))).rejects.toMatchObject(
      { code: "ROUTE_TRAPPED" },
    );
    expect(await count(routes.counter)).toBe(1);
  });

  it("puts only the trapped request's stderr in the error", async () => {
    const before = await count(routes.counter);
    const error = await routes.counter.fetch(new Request("http://localhost/panic")).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining(`counter panicked on request ${before + 1}`),
    });
    expect((error as Error).message).not.toMatch(
      new RegExp(`counter served request ${before}$`, "m"),
    );
  });
});

describe('instances: "per-request" in wasmtime', () => {
  let perRequest: { counter: WasiHttpRoute };

  beforeAll(async () => {
    const entry = await buildServerEntry(
      "instances-entry.ts",
      path.join(outDir, "per-request"),
      undefined,
      { ...wasmtime, instances: "per-request" },
    );
    perRequest = (await server.load(entry.file)) as typeof perRequest;
  });

  it("gives every request a fresh instance, so no state survives a request", async () => {
    const counts = [];
    for (let index = 0; index < 3; index++) counts.push(await count(perRequest.counter));
    expect(counts).toEqual([1, 1, 1]);
  });

  it("still turns a trap into ROUTE_TRAPPED and serves the next request", async () => {
    await expect(
      perRequest.counter.fetch(new Request("http://localhost/panic")),
    ).rejects.toMatchObject({ code: "ROUTE_TRAPPED" });
    expect(await count(perRequest.counter)).toBe(1);
  });

  it("catches traps in two bundles, each with its own copy of the addon, in turn", async () => {
    // On macOS, the copy that last ran a guest used to take over trap
    // handling for the thread, so this crashed the process with SIGILL.
    for (const route of [routes.panic, perRequest.counter, routes.panic, perRequest.counter]) {
      await expect(route.fetch(new Request("http://localhost/panic"))).rejects.toMatchObject({
        code: "ROUTE_TRAPPED",
      });
    }
  });
});

describe("Python routes in wasmtime", () => {
  it("serves GET with the path, query, headers, and a sibling module", async () => {
    const response = await routes.python.fetch(
      new Request("http://localhost/api/py?name=farm", { headers: { "x-greeting": "selam" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-served-by")).toBe("python");
    expect(await response.text()).toBe(
      "method=GET\npath=/api/py\nname=farm\ngreeting=selam\nhello from a sibling module\n",
    );
  });

  it("reads a JSON body and returns the status the route chose", async () => {
    const response = await routes.python.fetch(
      new Request("http://localhost/api/py", { method: "POST", body: '{"a":1}' }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ received: { a: 1 }, length: 7 });
  });

  it("turns an exception into ROUTE_TRAPPED that carries the traceback", async () => {
    await expect(routes.pythonRaise.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining("RuntimeError: fixture route raised on purpose"),
    });
  });
});

describe("Go routes in wasmtime", () => {
  it("serves a net/http handler with the path, query, headers, and a second package file", async () => {
    const response = await routes.go.fetch(
      new Request("http://localhost/api/go?name=farm", { headers: { "x-greeting": "selam" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-served-by")).toBe("go");
    expect(await response.text()).toBe(
      "method=GET\npath=/api/go?name=farm\ngreeting=selam\nhello from a second file in the package\nbody=\n",
    );
  });

  it("turns a panic into ROUTE_TRAPPED that carries the panic message", async () => {
    await expect(routes.goPanic.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining("fixture route panicked on purpose"),
    });
  });

  it("replaces an instance after it has served GO_REQUESTS_PER_INSTANCE requests", async () => {
    const counts = [];
    for (let index = 0; index <= GO_REQUESTS_PER_INSTANCE; index++) {
      counts.push(await count(routes.goCounter));
    }
    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(counts.at(-2)).toBe(GO_REQUESTS_PER_INSTANCE);
    expect(counts.at(-1)).toBe(1);
  });
});

describe("failing closed", () => {
  it("fails with RUNTIME_UNAVAILABLE while the machine code is missing, then recovers", async () => {
    const entry = await buildServerEntry(
      "instances-entry.ts",
      path.join(outDir, "missing"),
      undefined,
      wasmtime,
    );
    const { counter } = (await server.load(entry.file)) as {
      counter: WasiHttpRoute;
    };
    const files = path.join(path.dirname(entry.file), "polyroute");
    const [key] = (await readdir(files)).filter((name) => name !== "wasmtime");
    const machineCode = path.join(files, key!);
    await rename(machineCode, `${machineCode}-moved`);
    try {
      await expect(counter.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        message: expect.stringMatching(
          /^Route `counter\/route\.rs` was built with `experimental\.runtime: "wasmtime"` for `[\w-]+`, and this server \(\w+ \w+\) can't run it: its machine code didn't load/,
        ),
      });
    } finally {
      await rename(`${machineCode}-moved`, machineCode);
    }
    expect(await count(counter)).toBe(1);
  });

  it("rejects a route that sends HTTP requests instead of running it in jco", async () => {
    const failure = buildServerEntry(
      "outbound-entry.ts",
      path.join(outDir, "outbound"),
      undefined,
      {
        ...wasmtime,
        outbound: { allow: ["example.com"] },
      },
    );
    await expect(failure).rejects.toThrow(
      'PolyrouteError: `outbound/route.rs` sends HTTP requests (it imports `wasi:http/outgoing-handler`), which `experimental.runtime: "wasmtime"` doesn\'t support yet. Build it with the default runtime.',
    );
  });

  it("rejects an `experimental.runtime` value it doesn't know, naming the accepted ones", () => {
    expect(() => polyroute({ experimental: { runtime: "v8" as never } })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: '`experimental.runtime` must be "jco" or "wasmtime", but it\'s "v8".',
      }),
    );
  });
});
