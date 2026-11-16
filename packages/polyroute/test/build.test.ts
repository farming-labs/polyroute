import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("gives every request a fresh instance, so a trap doesn't affect the next request", async () => {
    await expect(routes.panic.fetch(new Request("http://localhost/"))).rejects.toThrow();
    const response = await routes.echo.fetch(new Request("http://localhost/after-panic"));
    expect(await response.text()).toContain("path=/after-panic\n");
  });
});

describe("build-time checks", () => {
  it("rejects a route that needs outbound HTTP, naming the missing interface", async () => {
    await expect(
      buildServerEntry("outbound-entry.ts", path.join(outDir, "outbound")),
    ).rejects.toThrow(/imports `wasi:http\/outgoing-handler`/);
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
