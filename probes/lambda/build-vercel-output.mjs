// Writes a Vercel Build Output (v3) directory with each benchmark route twice:
// as a native `executable` function and as its TypeScript twin on Node. A
// `/api/warmup` function serves the measurement harness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const probe = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(probe, "../..");
const { values } = parseArgs({
  options: { host: { type: "string" }, fixtures: { type: "string" }, output: { type: "string" } },
});
for (const key of ["host", "fixtures", "output"]) {
  if (!values[key]) throw new Error(`Provide --${key}; --output must be a new directory.`);
}
const output = path.resolve(values.output);
const host = await readFile(values.host);
// Vercel runs `executable` functions on x86_64 Linux by default.
if (host.subarray(0, 6).compare(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) !== 0)
  throw new Error("The host isn't a 64-bit little-endian ELF; build it in the Amazon Linux image.");
if (host.readUInt16LE(18) !== 62)
  throw new Error("The host isn't x86_64; build it for x86_64-unknown-linux-gnu.");
const fixtures = JSON.parse(await readFile(values.fixtures));
if (typeof zlib.zstdCompressSync !== "function")
  throw new Error("Use Node 22.15 or later; the Build Output compresses components with zstd.");
// Vercel's function file system read a raw 32 MB Python component at about
// 115 MB/s and the same component compressed at about 270 MB/s. On instances
// started for a waiting request, level 19 started faster than levels 1 and 3
// (ADR 0022).
const zstdLevel = 19;
const routes = [
  { name: "primes", native: "primes/route.rs" },
  { name: "slug", native: "slug/route.go" },
  { name: "stats", native: "stats/route.py" },
];
assert.deepEqual(Object.keys(fixtures).sort(), routes.map((route) => route.native).sort());

const require = createRequire(path.join(repo, "packages/polyroute/package.json"));
const { transformWithOxc } = await import(pathToFileURL(require.resolve("vite")).href);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [];
const nodeConfig = {
  runtime: "nodejs24.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
};

async function write(file, bytes, mode = 0o644) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx", mode });
  await chmod(file, mode);
  files.push({
    file: path.relative(output, file),
    bytes: bytes.length,
    sha256: digest(bytes),
    mode,
  });
}

await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
await write(path.join(output, "config.json"), JSON.stringify({ version: 3 }, null, 2) + "\n");
for (const route of routes) {
  const artifact = fixtures[route.native];
  const component = await readFile(artifact.component);
  assert.equal(digest(component), artifact.sha256, `${route.native} changed; prepare it again.`);
  const native = path.join(output, "functions/api", `${route.name}.func`);
  await write(path.join(native, "executable"), host, 0o755);
  const compressed = zlib.zstdCompressSync(component, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel },
    // The host needs the decompressed size in the frame header.
    pledgedSrcSize: component.length,
  });
  await write(path.join(native, "route.cwasm.zst"), compressed);
  const manifest = {
    component: "route.cwasm.zst",
    requestsPerInstance: route.native.endsWith(".go") ? 1000 : 0,
  };
  await write(path.join(native, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The same settings Vercel's Rust builder emits for a `vercel_runtime` function.
  const executableConfig = {
    runtime: "executable",
    handler: "executable",
    architecture: "x86_64",
    supportsResponseStreaming: true,
    runtimeLanguage: "rust",
  };
  await write(
    path.join(native, ".vc-config.json"),
    JSON.stringify(executableConfig, null, 2) + "\n",
  );

  const source = path.join(repo, "examples/polyglot/app/api", `${route.name}-ts`, "route.ts");
  const { code } = await transformWithOxc(await readFile(source, "utf8"), source, { lang: "ts" });
  const twin = path.join(output, "functions/api", `${route.name}-ts.func`);
  await write(path.join(twin, "index.mjs"), Buffer.from(code));
  await write(path.join(twin, ".vc-config.json"), JSON.stringify(nodeConfig, null, 2) + "\n");
}
// Only `measure-vercel-cold.mjs` calls this function. Its requests warm a new
// deployment's request path without touching a measured function.
const warmup = path.join(output, "functions/api/warmup.func");
const warmupCode = 'export function GET() {\n  return new Response("warm\\n");\n}\n';
await write(path.join(warmup, "index.mjs"), Buffer.from(warmupCode));
await write(path.join(warmup, ".vc-config.json"), JSON.stringify(nodeConfig, null, 2) + "\n");
await writeFile(
  path.join(output, "..", `${path.basename(output)}.files.json`),
  JSON.stringify({ host: digest(host), files }, null, 2) + "\n",
  { flag: "wx" },
);
console.log(`Wrote ${routes.length * 2 + 1} functions to ${output}.`);
