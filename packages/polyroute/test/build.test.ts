import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { polyroute } from "../src/index.js";
import { buildRustRoute } from "../src/languages/rust.js";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import {
  buildClientEntry,
  buildServerEntry,
  cacheDir,
  fixturesDir,
  type BuiltEntry,
} from "./helpers.js";

interface ServerEntry {
  echo: WasiHttpRoute;
  panic: WasiHttpRoute;
  crate: WasiHttpRoute;
  python: WasiHttpRoute;
  pythonRaise: WasiHttpRoute;
  go: WasiHttpRoute;
  goPanic: WasiHttpRoute;
  counter: WasiHttpRoute;
}

async function count(route: WasiHttpRoute, path = "/"): Promise<number> {
  return Number(await (await route.fetch(new Request(`http://localhost${path}`))).text());
}

let outDir: string;
let built: BuiltEntry;
let routes: ServerEntry;

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "polyroute-build-"));
  built = await buildServerEntry("server-entry.ts", path.join(outDir, "server"));
  routes = (await import(pathToFileURL(built.file).href)) as ServerEntry;
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("production build", () => {
  it("bundles the runtime and bindings so the output imports nothing but node: builtins", () => {
    expect(built.code).not.toMatch(/^\s*import\s[^;]*?from\s*["'](?!node:)/m);
    expect(built.code).not.toMatch(/\bimport\(\s*["'](?!node:)/);
  });

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

  it("builds a route that has its own Cargo.toml and several modules", async () => {
    const response = await routes.crate.fetch(new Request("http://localhost/"));
    expect(await response.text()).toBe("hello from a crate with its own Cargo.toml");
  });

  it("reports every local source file of a crate so dev can watch them", async () => {
    const crateDir = path.join(fixturesDir, "crate");
    const { sources } = await buildRustRoute({
      routeFile: path.join(crateDir, "route.rs"),
      label: "crate/route.rs",
      cacheDir: path.join(cacheDir, "polyroute"),
    });
    expect(sources.map((file) => path.relative(crateDir, file)).sort()).toEqual([
      "Cargo.toml",
      "greeting.rs",
      "route.rs",
    ]);
  });

  it("turns a panic into a ROUTE_TRAPPED error that carries the panic message", async () => {
    const failure = routes.panic.fetch(new Request("http://localhost/api/panic"));
    await expect(failure).rejects.toMatchObject({
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

describe("reused instances (the default)", () => {
  it("serves every request from one instance, so global state persists", async () => {
    const first = await count(routes.counter);
    expect([await count(routes.counter), await count(routes.counter)]).toEqual([
      first + 1,
      first + 2,
    ]);
  });

  it("hands concurrent requests to the instance one at a time", async () => {
    const counts = await Promise.all(Array.from({ length: 8 }, () => count(routes.counter)));
    const sorted = [...counts].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 8 }, (_, index) => sorted[0]! + index));
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

describe('instances: "per-request"', () => {
  let perRequest: { counter: WasiHttpRoute };

  beforeAll(async () => {
    const entry = await buildServerEntry(
      "instances-entry.ts",
      path.join(outDir, "per-request"),
      fixturesDir,
      { instances: "per-request" },
    );
    perRequest = (await import(pathToFileURL(entry.file).href)) as typeof perRequest;
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
});

describe("Python routes", () => {
  it("answers repeated requests from one reused interpreter", async () => {
    for (const name of ["one", "two", "three"]) {
      const response = await routes.python.fetch(
        new Request(`http://localhost/api/py?name=${name}`),
      );
      expect(await response.text()).toContain(`\nname=${name}\n`);
    }
  });

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
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ received: { a: 1 }, length: 7 });
  });

  it("answers HEAD from GET and other methods with 405 and allow", async () => {
    const head = await routes.python.fetch(
      new Request("http://localhost/api/py", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();

    const remove = await routes.python.fetch(
      new Request("http://localhost/api/py", { method: "DELETE" }),
    );
    expect(remove.status).toBe(405);
    expect(remove.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("turns an exception into ROUTE_TRAPPED that carries the traceback", async () => {
    await expect(routes.pythonRaise.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining("RuntimeError: fixture route raised on purpose"),
    });
  });
});

describe("Go routes", () => {
  it("answers repeated requests from one reused Go runtime", async () => {
    for (const name of ["one", "two", "three"]) {
      const response = await routes.go.fetch(new Request(`http://localhost/api/go?name=${name}`));
      expect(await response.text()).toContain(`path=/api/go?name=${name}\n`);
    }
  });

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

  it("passes the request body through and returns the status the handler wrote", async () => {
    const response = await routes.go.fetch(
      new Request("http://localhost/api/go", { method: "POST", body: "hello from js" }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toContain("body=hello from js\n");
  });

  it("turns a panic into ROUTE_TRAPPED that carries the panic message", async () => {
    await expect(routes.goPanic.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
      code: "ROUTE_TRAPPED",
      message: expect.stringContaining("fixture route panicked on purpose"),
    });
  });
});

describe("build-time checks", () => {
  it("rejects a route that needs outbound HTTP, naming the missing interface", async () => {
    await expect(
      buildServerEntry("outbound-entry.ts", path.join(outDir, "outbound")),
    ).rejects.toThrow(/imports `wasi:http\/outgoing-handler`/);
  });

  it("rejects an `instances` value it doesn't know, naming the accepted ones", () => {
    expect(() => polyroute({ instances: "shared" as never })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: '`instances` must be "reuse" or "per-request", but it\'s "shared".',
      }),
    );
  });

  it("rejects a .rs route imported from browser code", async () => {
    await expect(buildClientEntry("server-entry.ts", path.join(outDir, "client"))).rejects.toThrow(
      /is a server route but was imported from browser code/,
    );
  });
});

describe("prebuilt components", () => {
  it("serves a .wasm component that was built ahead of time", async () => {
    const { wasm } = await buildRustRoute({
      routeFile: path.join(fixturesDir, "echo/route.rs"),
      label: "echo/route.rs",
      cacheDir: path.join(cacheDir, "polyroute"),
    });
    const root = path.join(outDir, "prebuilt-root");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "route.wasm"), wasm);
    await writeFile(
      path.join(root, "entry.ts"),
      'export { default as route } from "./route.wasm";\n',
    );

    const prebuilt = await buildServerEntry("entry.ts", path.join(outDir, "prebuilt"), root);
    const { route } = (await import(pathToFileURL(prebuilt.file).href)) as {
      route: WasiHttpRoute;
    };
    const response = await route.fetch(new Request("http://localhost/prebuilt"));
    expect(response.headers.get("x-served-by")).toBe("rust");
    expect(await response.text()).toContain("path=/prebuilt\n");
  });
});
