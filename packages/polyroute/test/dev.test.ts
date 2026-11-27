import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { polyroute } from "../src/index.js";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { cacheDir, fixturesDir } from "./helpers.js";

let root: string;
let routeFile: string;
let pythonDir: string;
let server: ViteDevServer;
let onSsrUpdate: ((file: string) => void) | undefined;

// Vite invalidates changed modules before it runs `hotUpdate`, so this hook is
// a deterministic signal that the next load will rebuild the route.
const updateSignal: Plugin = {
  name: "test:update-signal",
  hotUpdate({ file }) {
    if (this.environment.name === "ssr") onSsrUpdate?.(file);
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "polyroute-dev-")));
  routeFile = path.join(root, "route.rs");
  await copyFile(path.join(fixturesDir, "echo", "route.rs"), routeFile);
  const nested = path.join(root, "api", "nested");
  await mkdir(nested, { recursive: true });
  const handler = await readFile(path.join(fixturesDir, "crate", "route.rs"), "utf8");
  await writeFile(path.join(nested, "route.rs"), handler.replace("mod greeting;", ""));
  const manifest = await readFile(path.join(fixturesDir, "crate", "Cargo.toml"), "utf8");
  await writeFile(
    path.join(nested, "Cargo.toml"),
    manifest.replace(
      "[dependencies]",
      '[dependencies]\ngreeting = { path = "../../shared greeting" }',
    ),
  );
  const sharedDir = path.join(root, "shared greeting");
  await mkdir(path.join(sharedDir, "src"), { recursive: true });
  await writeFile(
    path.join(sharedDir, "Cargo.toml"),
    '[package]\nname = "greeting"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  await writeFile(
    path.join(sharedDir, "src/lib.rs"),
    'pub fn message() -> String { "before".into() }',
  );
  pythonDir = path.join(root, "py");
  await mkdir(pythonDir);
  for (const file of ["route.py", "greeting.py"]) {
    await copyFile(path.join(fixturesDir, "python", "echo", file), path.join(pythonDir, file));
  }
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    cacheDir,
    plugins: [polyroute(), updateSignal],
    server: { middlewareMode: true },
    appType: "custom",
  });
  // The first build of each route is a cold build, which can take minutes
  // when other test files compile at the same time. It belongs to setup, so
  // the tests below time only the rebuild after an edit.
  await Promise.all([loadRoute(), loadRoute("/api/nested/route.rs"), loadPythonRoute()]);
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function loadRoute(id = "/route.rs"): Promise<WasiHttpRoute> {
  const module = (await server.ssrLoadModule(id)) as { default: WasiHttpRoute };
  return module.default;
}

async function loadPythonRoute(): Promise<WasiHttpRoute> {
  const module = (await server.ssrLoadModule("/py/route.py")) as { default: WasiHttpRoute };
  return module.default;
}

it("rebuilds a Rust route after a local Cargo path dependency changes", async () => {
  const request = new Request("http://localhost/api/nested");
  const routeId = "/api/nested/route.rs";
  const before = await loadRoute(routeId);
  expect(await (await before.fetch(request)).text()).toBe("before");
  const shared = path.join(root, "shared greeting", "src", "lib.rs");
  const changed = new Promise<void>((resolve) => {
    onSsrUpdate = (file) => {
      if (path.resolve(file) === shared) resolve();
    };
  });
  await writeFile(shared, 'pub fn message() -> String { "after".into() }');
  await changed;
  const after = await loadRoute(routeId);
  expect(await (await after.fetch(request)).text()).toBe("after");
});

it("serves a .rs route in dev and rebuilds it when the file changes", async () => {
  const before = await loadRoute();
  expect(await (await before.fetch(new Request("http://localhost/dev"))).text()).toContain(
    "method=GET\n",
  );

  const changed = new Promise<void>((resolve) => {
    onSsrUpdate = (file) => {
      if (path.resolve(file) === routeFile) resolve();
    };
  });
  const source = await readFile(routeFile, "utf8");
  await writeFile(routeFile, source.replace('"method={method}', '"verb={method}'));
  await changed;

  const after = await loadRoute();
  expect(await (await after.fetch(new Request("http://localhost/dev"))).text()).toContain(
    "verb=GET\n",
  );
});

it("rebuilds a Python route when a module next to it changes", async () => {
  const before = await loadPythonRoute();
  expect(await (await before.fetch(new Request("http://localhost/"))).text()).toContain(
    "hello from a sibling module\n",
  );

  const sibling = path.join(pythonDir, "greeting.py");
  const changed = new Promise<void>((resolve) => {
    onSsrUpdate = (file) => {
      if (path.resolve(file) === sibling) resolve();
    };
  });
  const source = await readFile(sibling, "utf8");
  await writeFile(sibling, source.replace("a sibling module", "an edited sibling"));
  await changed;

  const after = await loadPythonRoute();
  expect(await (await after.fetch(new Request("http://localhost/"))).text()).toContain(
    "hello from an edited sibling\n",
  );
});

it("keeps Python portable in dev when the native build runtime is selected", async () => {
  const nativeBuildServer = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    cacheDir,
    plugins: [polyroute({ experimental: { runtime: "wasmtime" } })],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const module = (await nativeBuildServer.ssrLoadModule("/py/route.py")) as {
      default: WasiHttpRoute;
    };
    const response = await module.default.fetch(new Request("http://localhost/native-dev"));
    expect(await response.text()).toContain("method=GET\npath=/native-dev\n");
  } finally {
    await nativeBuildServer.close();
  }
});
