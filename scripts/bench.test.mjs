import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { benchmarkRoutes } from "./bench-routes.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../examples/polyglot/package.json", import.meta.url));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const exec = promisify(execFile);
const typescriptRoutes = benchmarkRoutes.filter((route) => route.language === "TypeScript");
let directory;
let server;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "polyroute-bench-test-"));
  const entry = path.join(directory, "entry.mjs");
  const example = path.join(repo, "examples/polyglot");
  const imports = ["hello", "primes-ts", "slug-ts", "stats-ts", "relay-ts"];
  const source = (...parts) =>
    JSON.stringify(
      path
        .join(...parts)
        .split(path.sep)
        .join("/"),
    );
  await writeFile(
    entry,
    [
      'import http from "node:http";',
      `import { toRequest, sendResponse } from ${source(example, "src/node.ts")};`,
      ...imports.map(
        (name, index) =>
          `import * as route${index} from ${source(example, "app/api", name, "route.ts")};`,
      ),
      `const routes = { ${imports.map((name, index) => `${JSON.stringify(`/api/${name}`)}: route${index}`).join(", ")} };`,
      `const server = http.createServer(async (req, res) => {
        try {
          const request = toRequest(req);
          const handler = routes[new URL(request.url).pathname]?.[request.method];
          await sendResponse(res, handler ? await handler(request) : new Response("missing", { status: 404 }));
        } catch (error) {
          console.error(error);
          res.writeHead(500).end();
        }
      });
      server.listen(0, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + server.address().port));`,
    ].join("\n"),
  );
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      ssr: entry,
      outDir: path.join(directory, "dist"),
      target: "node22",
      rolldownOptions: { output: { entryFileNames: "server.mjs" } },
    },
  });
  server = path.join(directory, "dist/server.mjs");
});

after(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true });
});

const run = (...args) =>
  exec(
    process.execPath,
    [
      "scripts/bench.mjs",
      "--server",
      server,
      "--matched",
      "--json",
      "--rounds",
      "2",
      "--duration",
      "0.02",
      "--warmup",
      "0.01",
      "--connections",
      "1",
      ...args,
    ],
    { cwd: repo },
  );

test("paired TypeScript workloads produce the expected bodies from a production build", async () => {
  const { stdout, stderr } = await run(
    ...typescriptRoutes.flatMap((route) => ["--route", route.name]),
  );
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, "throughput");
  assert.equal(report.samplesDiscarded, 0);
  assert.equal(report.settings.matched, true);
  assert.equal(report.results.length, typescriptRoutes.length);
  for (const result of report.results) {
    assert.equal(result.errors, 0);
    assert.equal(result.rounds.length, 2);
    assert.ok(result.medianRps > 0);
    assert.ok(result.medianP95Ms >= result.medianP50Ms);
    assert.ok(result.medianP99Ms >= result.medianP95Ms);
  }
  const lines = stderr.split("\n").filter((line) => line.startsWith("round "));
  assert.ok(lines[0].includes(typescriptRoutes[0].name));
  assert.ok(lines[typescriptRoutes.length].includes(typescriptRoutes.at(-1).name));
});

test("cold A/A results retain each sample and report median and p95", async () => {
  const { stdout } = await run("--cold", "--baseline", server, "--route", "TypeScript");
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "cold");
  assert.equal(report.results.length, 2);
  assert.deepEqual(
    report.builds.map((build) => build.file),
    [server, server],
  );
  for (const result of report.results) {
    assert.equal(result.samplesMs.length, 2);
    assert.ok(result.medianMs > 0);
    assert.equal(result.p95Ms, Math.max(...result.samplesMs));
  }
});

test("an incorrect response fails instead of producing a performance result", async () => {
  await assert.rejects(run("--route", "Go"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /didn't answer 200 with the expected body/);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("fractional rounds and connection counts fail as usage errors", async () => {
  for (const flag of ["--rounds", "--connections"]) {
    await assert.rejects(run(flag, "1.5"), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /must be a positive integer/);
      return true;
    });
  }
});

test("an unknown route is rejected even when another selected route exists", async () => {
  await assert.rejects(run("--route", "TypeScript", "--route", "typo"), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /Unknown `--route`: typo/);
    return true;
  });
});
