import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { polyroute } from "../src/index.js";
import { GO_REQUESTS_PER_INSTANCE } from "../src/languages/go.js";
import { python } from "../src/languages/python.js";
import { buildRustRoute } from "../src/languages/rust.js";
import { IncomingRequest } from "../src/runtime/host.js";
import { createWasiHttpHandler, type WasiHttpRoute } from "../src/runtime/index.js";
import { transpileRoute } from "../src/transpile.js";
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
  goCounter: WasiHttpRoute;
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

  it("reads JCO_DEBUG once per route instead of on every call into the guest", () => {
    const reads = built.code.split("\n").filter((line) => line.includes("JCO_DEBUG"));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read).toMatch(
        /^(?:const|var) __polyrouteJcoDebug\S* = Boolean\(globalThis\?\.process\?\.env\?\.JCO_DEBUG\);$/,
      );
    }
  });

  it("calls every synchronous host import without jco's async task bookkeeping", () => {
    // The server entry has Rust, Python, and Go routes. Each import's trampoline
    // starts with the may-leave check jco used to run in the lowering wrapper.
    const trampolines = built.code.match(/\b_trampoline\d+\.fnName = "/g) ?? [];
    const direct =
      built.code.match(
        /\$checkMayLeave(?:\$\d+)?\(_jcoTaskCompatImportContext\.mayLeave, \d+\);/g,
      ) ?? [];
    expect(trampolines.length).toBeGreaterThan(0);
    expect(direct.length).toBe(trampolines.length);
    expect(built.code).not.toMatch(/_lowerImportBackwardsCompat(?:\$\d+)?\.bind\(/);
  });

  it("doesn't record every resource the host creates in a Set that only grows", () => {
    expect(built.code).toMatch(/\._createdReps = /);
    expect(built.code).not.toMatch(/_createdReps\.add\(/);
  });

  it("writes each route's core modules to files next to the bundle instead of inlining them", async () => {
    // A base64 string this long can only be an inlined core module.
    expect(built.code).not.toMatch(/"[A-Za-z0-9+/]{4096,}={0,2}"/);
    const referenced = [
      ...built.code.matchAll(
        /new URL\("\.\/(polyroute\/[0-9a-f]{32}\/[^"]+\.wasm)", import\.meta\.url\)/g,
      ),
    ].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const root = path.dirname(built.file);
    const written = (
      await readdir(path.join(root, "polyroute"), { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .map((file) => file.split(path.sep).join("/"));
    expect(written.sort()).toEqual([...new Set(referenced)].sort());
    for (const file of written) {
      expect(WebAssembly.validate(await readFile(path.join(root, file)))).toBe(true);
    }
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

  it("hands requests that were waiting on an instance that trapped to a new one", async () => {
    const [trapped, ...rest] = await Promise.allSettled([
      routes.counter.fetch(new Request("http://localhost/panic")),
      ...Array.from({ length: 5 }, () => count(routes.counter)),
    ]);
    expect(trapped).toMatchObject({ status: "rejected", reason: { code: "ROUTE_TRAPPED" } });
    expect(rest).toEqual([1, 2, 3, 4, 5].map((value) => ({ status: "fulfilled", value })));
  });
});

describe("host calls", () => {
  async function loadRoute(fixture: string): Promise<WasiHttpRoute> {
    const label = `${fixture}/route.rs`;
    const routeCache = path.join(cacheDir, "polyroute");
    const routeFile = path.join(fixturesDir, label);
    const { wasm } = await buildRustRoute({ routeFile, label, cacheDir: routeCache });
    const transpiled = await transpileRoute(wasm, label, routeCache, "");
    const file = path.join(outDir, `bindings-${transpiled.key}.mjs`);
    await writeFile(file, transpiled.bindings);
    const { instantiate } = (await import(pathToFileURL(file).href)) as {
      instantiate: Parameters<typeof createWasiHttpHandler>[0]["instantiate"];
    };
    return createWasiHttpHandler({
      route: label,
      instantiate,
      coreModules: transpiled.coreModules,
    });
  }

  it("traps the instance when a host call throws, and the next request gets a new one", async () => {
    const route = await loadRoute("counter");
    expect(await count(route)).toBe(1);
    expect(await count(route)).toBe(2);

    const method = Object.getOwnPropertyDescriptor(IncomingRequest.prototype, "method")!;
    Object.defineProperty(IncomingRequest.prototype, "method", {
      ...method,
      value() {
        throw new Error("host call failed on purpose");
      },
    });
    try {
      await expect(route.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
        code: "ROUTE_TRAPPED",
        message: expect.stringContaining("host call failed on purpose"),
      });
    } finally {
      Object.defineProperty(IncomingRequest.prototype, "method", method);
    }
    expect(await count(route)).toBe(1);
  });
});

describe("a route in a lazily loaded chunk", () => {
  let lazyDir: string;
  let loadEcho: () => Promise<{ default: WasiHttpRoute }>;

  beforeAll(async () => {
    lazyDir = path.join(outDir, "lazy");
    await build({
      root: fixturesDir,
      configFile: false,
      logLevel: "silent",
      cacheDir,
      plugins: [polyroute()],
      build: {
        ssr: "lazy-entry.ts",
        outDir: lazyDir,
        emptyOutDir: true,
        minify: false,
        rolldownOptions: {
          output: { entryFileNames: "server.js", chunkFileNames: "chunks/[name]-[hash].js" },
        },
      },
    });
    ({ loadEcho } = (await import(pathToFileURL(path.join(lazyDir, "server.js")).href)) as {
      loadEcho: typeof loadEcho;
    });
  });

  it("writes the route's core modules next to its own chunk", async () => {
    expect(existsSync(path.join(lazyDir, "polyroute"))).toBe(false);
    expect(await readdir(path.join(lazyDir, "chunks", "polyroute"))).toHaveLength(1);
  });

  it("fails with ROUTE_INSTANTIATION_FAILED while a core module file is missing, then recovers", async () => {
    const files = path.join(lazyDir, "chunks", "polyroute");
    const { default: route } = await loadEcho();
    await rename(files, `${files}-moved`);
    try {
      await expect(route.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
        code: "ROUTE_INSTANTIATION_FAILED",
        message: expect.stringContaining("Deploy the `polyroute` directory"),
      });
    } finally {
      await rename(`${files}-moved`, files);
    }
    expect((await route.fetch(new Request("http://localhost/"))).status).toBe(200);
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

describe("JCO_DEBUG", () => {
  it("turns on jco's debug logs for routes loaded while it's set", async () => {
    const entry = await buildServerEntry("instances-entry.ts", path.join(outDir, "jco-debug"));
    process.env.JCO_DEBUG = "1";
    let debugging: { counter: WasiHttpRoute };
    try {
      debugging = (await import(pathToFileURL(entry.file).href)) as typeof debugging;
    } finally {
      delete process.env.JCO_DEBUG;
    }

    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await count(routes.counter);
      expect(debug).not.toHaveBeenCalled();
      expect(await count(debugging.counter)).toBe(1);
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
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

  it("replaces an instance after it has served GO_REQUESTS_PER_INSTANCE requests", async () => {
    const counts = [];
    for (let index = 0; index <= GO_REQUESTS_PER_INSTANCE; index++) {
      counts.push(await count(routes.goCounter));
    }
    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(counts.at(-2)).toBe(GO_REQUESTS_PER_INSTANCE);
    expect(counts.at(-1)).toBe(1);
  });

  it("serves concurrent requests across a replacement without failing any", async () => {
    const counts = await Promise.all(
      Array.from({ length: 2 * GO_REQUESTS_PER_INSTANCE + 3 }, () => count(routes.goCounter)),
    );
    expect(Math.max(...counts)).toBe(GO_REQUESTS_PER_INSTANCE);
    expect(counts.filter((value) => value === 1).length).toBeGreaterThanOrEqual(2);
  });
});

describe("build-time checks", () => {
  it("rejects a route that sends HTTP requests unless `outbound` lists hosts", async () => {
    // Rolldown reports the Rust, Go, and Python routes' errors together.
    const failure = buildServerEntry("outbound-entry.ts", path.join(outDir, "outbound"));
    await expect(failure).rejects.toThrow(
      'PolyrouteError: `outbound/route.rs` sends HTTP requests (it imports `wasi:http/outgoing-handler`), and polyroute allows none by default. List the hosts routes may call, for example `polyroute({ outbound: { allow: ["api.example.com"] } })`.',
    );
    await expect(failure).rejects.toThrow(
      "PolyrouteError: `go/outbound/route.go` sends HTTP requests",
    );
    await expect(failure).rejects.toThrow(
      "PolyrouteError: `python/outbound/route.py` sends HTTP requests",
    );
  });

  it("rejects an async Python handler in a route that can't send requests", async () => {
    const label = "python/async/route.py";
    await expect(
      python.build({
        routeFile: path.join(fixturesDir, label),
        label,
        cacheDir: path.join(cacheDir, "polyroute"),
      }),
    ).rejects.toMatchObject({
      code: "BUILD_FAILED",
      message: expect.stringContaining(
        "route.py has an async handler, which polyroute runs on componentize-py's poll_loop.",
      ),
    });
  });

  it("rejects every `outbound.allow` entry that isn't a host, at once", () => {
    expect(() =>
      polyroute({
        outbound: { allow: ["api.example.com", "https://example.com", "example.com/path", ""] },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message:
          'Every `outbound.allow` entry must be a host such as `api.example.com`, `localhost:8787`, `*.example.com`, or `*`, without a scheme or path. These aren\'t: "https://example.com", "example.com/path", "".',
      }),
    );
  });

  it("rejects an `instances` value it doesn't know, naming the accepted ones", () => {
    expect(() => polyroute({ instances: "shared" as never })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: '`instances` must be "reuse" or "per-request", but it\'s "shared".',
      }),
    );
  });

  it("rejects a `requestsPerInstance` that isn't a positive integer", () => {
    for (const requestsPerInstance of [0, 1.5, Number.NaN]) {
      expect(() =>
        createWasiHttpHandler({
          route: "route.go",
          instantiate: () => Promise.reject(new Error("unused")),
          coreModules: {},
          requestsPerInstance,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: `\`requestsPerInstance\` must be a positive integer, but it's ${requestsPerInstance}.`,
        }),
      );
    }
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
