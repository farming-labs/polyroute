import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { polyroute } from "../src/index.js";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { cacheDir, fixturesDir } from "./helpers.js";

let root: string;
let routeFile: string;
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
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    cacheDir,
    plugins: [polyroute(), updateSignal],
    server: { middlewareMode: true },
    appType: "custom",
  });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function loadRoute(): Promise<WasiHttpRoute> {
  const module = (await server.ssrLoadModule("/route.rs")) as { default: WasiHttpRoute };
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
