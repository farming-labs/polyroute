import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const builder = fileURLToPath(new URL("../probes/lambda/build-vercel-output.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "polyroute-vercel-package-"));
  t.after(() => rm(root, { recursive: true }));
  // Synthetic bytes verify packaging only; CI executes the real Linux host.
  const host = Buffer.alloc(64);
  host.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  host.writeUInt16LE(62, 18);
  const component = Buffer.from("fixture component");
  await writeFile(path.join(root, "host"), host);
  await writeFile(path.join(root, "route.cwasm"), component);
  const artifacts = Object.fromEntries(
    ["primes/route.rs", "slug/route.go", "stats/route.py"].map((route) => [
      route,
      {
        component: path.join(root, "route.cwasm"),
        sha256: createHash("sha256").update(component).digest("hex"),
      },
    ]),
  );
  await writeFile(path.join(root, "fixtures.json"), JSON.stringify(artifacts));
  const output = path.join(root, "missing parent", ".vercel", "output");
  return {
    output,
    host,
    component,
    run: () =>
      exec(process.execPath, [
        builder,
        "--host",
        path.join(root, "host"),
        "--fixtures",
        path.join(root, "fixtures.json"),
        "--output",
        output,
      ]),
  };
}

test("Vercel packaging creates missing output parents and preserves artifact bytes", async (t) => {
  const { output, host, component, run } = await fixture(t);
  await run();
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "config.json"))), { version: 3 });
  assert.deepEqual((await readdir(path.join(output, "functions/api"))).sort(), [
    "primes-ts.func",
    "primes.func",
    "slug-ts.func",
    "slug.func",
    "stats-ts.func",
    "stats.func",
    "warmup.func",
  ]);
  for (const name of ["primes", "slug", "stats"]) {
    const native = path.join(output, "functions/api", `${name}.func`);
    assert.deepEqual(await readFile(path.join(native, "executable")), host);
    assert.deepEqual(await readFile(path.join(native, "route.cwasm")), component);
  }
  // `measure-vercel-cold.mjs` requires exactly this body from the warmup function.
  const warmup = path.join(output, "functions/api/warmup.func/index.mjs");
  const { GET } = await import(pathToFileURL(warmup).href);
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "warm\n");
});

test("Vercel packaging refuses an existing output without changing its contents", async (t) => {
  const { output, run } = await fixture(t);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "sentinel"), "existing output");
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /EEXIST/);
    return true;
  });
  assert.deepEqual(await readdir(output), ["sentinel"]);
  assert.equal(await readFile(path.join(output, "sentinel"), "utf8"), "existing output");
});
