import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const probe = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(probe, "../..");
const { values } = parseArgs({
  options: { output: { type: "string" }, set: { type: "string", default: "fixtures" } },
});
if (!values.output) throw new Error("Missing --output; provide a new artifact directory.");
// `fixtures` are the protocol test routes. `benchmark` are the example routes
// that have TypeScript twins with the same algorithm.
const sets = {
  fixtures: {
    root: "packages/polyroute/test/fixtures",
    routes: [
      "counter/route.rs",
      "go/counter/route.go",
      "echo/route.rs",
      "python/response/route.py",
      "outbound/route.rs",
      "go/outbound/route.go",
      "python/outbound/route.py",
    ],
  },
  benchmark: {
    root: "examples/polyglot/app/api",
    routes: ["primes/route.rs", "slug/route.go", "stats/route.py"],
  },
};
const set = sets[values.set];
if (!set) throw new Error(`Unknown --set \`${values.set}\`; use fixtures or benchmark.`);
const output = path.resolve(values.output);
await mkdir(output);
const provenance = JSON.parse(await readFile(path.join(probe, "provenance.json")));
for (const source of provenance.productionSources) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(repo, source.file)))
    .digest("hex");
  assert.equal(
    digest,
    source.sha256,
    `Production source changed: ${source.file}. Review the probe contract before updating its provenance.`,
  );
}
const require = createRequire(path.join(repo, "packages/polyroute/package.json"));
const { build } = await import(require.resolve("vite"));
const { polyroute } = await import(path.join(repo, "packages/polyroute/dist/index.js"));
const fixtures = path.join(repo, set.root);
const { routes } = set;
const entry = path.join(output, "entry.ts");
await writeFile(
  entry,
  routes
    .map(
      (route, index) =>
        `export { default as route${index} } from ${JSON.stringify(path.join(fixtures, route))};`,
    )
    .join("\n") + "\n",
);
const bundle = path.join(output, "bundle");
const built = await build({
  root: fixtures,
  configFile: false,
  logLevel: "warn",
  cacheDir: path.join(repo, "packages/polyroute/node_modules/.cache/polyroute-test"),
  plugins: [
    polyroute({ outbound: { allow: ["127.0.0.1"] }, experimental: { runtime: "wasmtime" } }),
  ],
  build: { ssr: entry, outDir: bundle, emptyOutDir: false, minify: false, target: "node22" },
});
const chunk = (Array.isArray(built) ? built : [built])
  .flatMap((result) => result.output)
  .find((item) => item.type === "chunk" && item.isEntry);
assert.ok(chunk, "Missing fixture bundle.");
const code = await readFile(path.join(bundle, chunk.fileName), "utf8");
const found = {};
for (const match of code.matchAll(/route: "([^"]+)",([\s\S]+?)\n\}/g)) {
  const artifact = match[2].match(/component: new URL\("\.\/([^"]+)"/);
  if (!artifact) continue;
  const component = path.join(bundle, artifact[1]);
  const bytes = await readFile(component);
  found[match[1]] = {
    component,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
assert.deepEqual(Object.keys(found).sort(), [...routes].sort());
await writeFile(path.join(output, "fixtures.json"), JSON.stringify(found, null, 2) + "\n");
console.log(`Prepared ${routes.length} native fixture components.`);
