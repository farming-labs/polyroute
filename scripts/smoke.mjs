#!/usr/bin/env node
// Builds the example app, starts the production output with plain `node`, and
// checks every route over real HTTP. With `--packed`, the example is copied out
// of the workspace and installed from a packed tarball, the way users get it.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = path.join(repo, "packages/polyroute");
const exampleDir = path.join(repo, "examples/polyglot");
const packed = process.argv.includes("--packed");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}  (in ${path.relative(repo, cwd) || "."})`);
  // pnpm, npm, and npx are .cmd shims on Windows, which only a shell can run.
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0)
    throw new Error(`\`${command} ${args.join(" ")}\` exited with ${result.status}.`);
}

async function prepareWorkspaceApp() {
  run("pnpm", ["--filter", "@farming-labs/polyroute", "build"], repo);
  run("pnpm", ["--filter", "polyroute-example-polyglot", "build"], repo);
  return { appDir: exampleDir, cleanup: async () => {} };
}

async function preparePackedApp() {
  const workDir = await mkdtemp(path.join(tmpdir(), "polyroute-smoke-"));
  run("pnpm", ["--filter", "@farming-labs/polyroute", "build"], repo);
  run("pnpm", ["pack", "--pack-destination", workDir], packageDir);
  const tarball = (await readdir(workDir)).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack produced no tarball.");

  const appDir = path.join(workDir, "app");
  await cp(exampleDir, appDir, {
    recursive: true,
    filter: (source) =>
      !path
        .relative(exampleDir, source)
        .split(path.sep)
        .some((segment) => segment === "node_modules" || segment === "dist"),
  });
  const manifestPath = path.join(appDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@farming-labs/polyroute"] = `file:${path.join(workDir, tarball)}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  run("npm", ["install", "--no-audit", "--no-fund"], appDir);
  run("npx", ["vite", "build"], appDir);
  return { appDir, cleanup: () => rm(workDir, { recursive: true, force: true }) };
}

function startServer(appDir) {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: appDir,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.on("exit", (code) =>
      reject(new Error(`The server exited with ${code} before it was ready.`)),
    );
  });
  return { child, ready };
}

const checks = [
  {
    name: "TypeScript route",
    path: "/api/hello",
    status: 200,
    body: '{"message":"Hello from TypeScript"}',
  },
  {
    name: "Rust route with a query",
    path: "/api/primes?limit=100",
    status: 200,
    body: '{"limit":100,"primes":25}',
  },
  {
    name: "Rust route reads the request body",
    path: "/api/shout",
    method: "POST",
    send: "polyroute",
    status: 200,
    body: "POLYROUTE",
  },
  {
    name: "Rust route rejects other methods",
    path: "/api/primes",
    method: "DELETE",
    status: 405,
    body: "",
  },
  {
    name: "Python route uses the standard library",
    path: "/api/stats",
    method: "POST",
    send: "[1, 2, 3, 4]",
    status: 200,
    body: '{"count":4,"mean":2.5,"median":2.5}',
  },
  {
    name: "Python route rejects bad input",
    path: "/api/stats",
    method: "POST",
    send: '"nope"',
    status: 400,
  },
  {
    name: "Go route reads the query",
    path: "/api/slug?text=Hello%20World,%20Farm!",
    status: 200,
    body: '{"slug":"hello-world-farm","text":"Hello World, Farm!"}\n',
  },
  // The relay route sends a request, which needs JSPI (Node 24 and later).
  // Without it, the route fails with UNSUPPORTED_RUNTIME and the server answers 500.
  typeof WebAssembly.Suspending === "function"
    ? {
        name: "Rust route calls another route over HTTP",
        path: "/api/relay",
        status: 200,
        body: '{"relayed":{"message":"Hello from TypeScript"}}',
      }
    : {
        name: "Rust route that sends requests fails without JSPI",
        path: "/api/relay",
        status: 500,
      },
  { name: "unknown path", path: "/api/missing", status: 404 },
];

const { appDir, cleanup } = packed ? await preparePackedApp() : await prepareWorkspaceApp();
const { child, ready } = startServer(appDir);
let failures = 0;
try {
  const origin = await ready;
  for (const check of checks) {
    const response = await fetch(`${origin}${check.path}`, {
      method: check.method ?? "GET",
      body: check.send,
    });
    const body = await response.text();
    const ok =
      response.status === check.status && (check.body === undefined || body === check.body);
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${check.name}: ${response.status} ${JSON.stringify(body)}`,
    );
  }
} finally {
  // Windows keeps a running process's working directory locked, so the packed
  // app's folder can only be removed after the server has actually exited.
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await cleanup();
}

if (failures > 0) {
  console.error(`${failures} of ${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks.length} checks passed (${packed ? "packed tarball" : "workspace"}).`);
