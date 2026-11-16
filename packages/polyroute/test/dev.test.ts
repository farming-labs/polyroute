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
  await Promise.all([loadRoute(), loadPythonRoute()]);
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function loadRoute(): Promise<WasiHttpRoute> {
  const module = (await server.ssrLoadModule("/route.rs")) as { default: WasiHttpRoute };
  return module.default;
}

async function loadPythonRoute(): Promise<WasiHttpRoute> {
  const module = (await server.ssrLoadModule("/py/route.py")) as { default: WasiHttpRoute };
  return module.default;
}

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
