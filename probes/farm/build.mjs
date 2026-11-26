import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transpileRoute } from "../../packages/polyroute/dist/transpile.js";
import { findLanguage } from "../../packages/polyroute/dist/languages/index.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const exampleAPI = fileURLToPath(new URL("../../examples/polyglot/app/api/", import.meta.url));
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
const output = await mkdtemp(path.join(dist, "build-"));
const project = path.join(output, "project");
await cp(path.join(root, "app"), project, { recursive: true });
const apiDir = path.join(project, "src/app/api");
await mkdir(apiDir, { recursive: true });
for (const name of ["primes", "primes-ts"]) {
  await cp(path.join(exampleAPI, name), path.join(apiDir, name), { recursive: true });
}
await writeFile(
  path.join(project, "package.json"),
  JSON.stringify({
    name: "farm-route-output-fixture",
    private: true,
    type: "module",
  }),
);
const componentDir = path.join(output, "wasi");
await mkdir(componentDir);
const routes = [];
const assets = new Map();
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(source);
      continue;
    }
    if (path.parse(entry.name).name !== "route") continue;
    const language = findLanguage(source);
    if (!language || (language.accepts && !(await language.accepts(source)))) continue;
    const label = path.relative(project, source);
    const route = path.relative(path.join(project, "src/app"), dir).split(path.sep).join("/");
    const { wasm } = await language.build({
      routeFile: source,
      label,
      cacheDir: path.join(dist, "cache"),
      runtime: "jco",
    });
    // Each route is packaged as a standalone WASI HTTP component. The Node build
    // imports a byte-identical copy so the two hosts execute the same guest.
    const compiled = await transpileRoute(
      wasm,
      label,
      path.join(dist, "cache"),
      language.handlerHint,
    );
    if (compiled.outbound)
      throw new Error(
        `The deployment probe requires an offline route. Remove outbound HTTP from ${label}.`,
      );
    assets.set(compiled.key, compiled.coreModules);
    const artifact = route + "/route.wasm";
    await mkdir(path.join(componentDir, route), { recursive: true });
    await writeFile(path.join(componentDir, artifact), wasm);
    await writeFile(path.join(dir, "handler.wasm"), wasm);
    await writeFile(
      path.join(dir, "route.ts"),
      'export { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } from "./handler.wasm";\n',
      { flag: "wx" },
    );
    routes.push({ path: "/" + route, component: artifact });
  }
}
await visit(apiDir);
await writeFile(path.join(componentDir, "routes.json"), JSON.stringify(routes, null, 2) + "\n");
const cli = path.join(root, "node_modules/@farm.js/cli/bin/farm.js");
const build = spawnSync(process.execPath, [cli, "build", "--preset", "node-server"], {
  cwd: project,
  stdio: "inherit",
  env: { ...process.env, FARM_SKIP_NPM_INSTALL: "1" },
});
if (build.error) throw build.error;
if (build.status !== 0) throw Error("Farm build failed in " + project);
const nodeOutput = path.join(output, "node");
await cp(path.join(project, ".farm/.output"), nodeOutput, { recursive: true });
// Farm 0.1.87 captures its SSR chunks before Polyroute's post-generateBundle
// assets are emitted. Restore the code assets beside the chunk that loads them.
for (const [key, modules] of assets) {
  const dir = path.join(nodeOutput, "server/farm-ssr/polyroute", key);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(modules)) {
    await writeFile(path.join(dir, name), Buffer.from(bytes, "base64"));
  }
}
console.log("Build output:", output);
