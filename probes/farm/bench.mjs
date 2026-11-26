import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const [build, action] = process.argv.slice(2);
const smokeOnly = action === "--smoke";
if (action && !smokeOnly) throw Error("Use --smoke or omit the option for the benchmark.");
if (!build) throw Error("Pass the build directory printed by build.mjs.");

const deployment = await realpath(await mkdtemp(path.join(os.tmpdir(), "farm-wasi-deployment-")));
await cp(path.resolve(build, "node"), path.join(deployment, "node"), { recursive: true });
await cp(path.resolve(build, "wasi"), path.join(deployment, "wasi"), { recursive: true });
const ts = await readFile(
  new URL("../../examples/polyglot/app/api/primes-ts/route.ts", import.meta.url),
  "utf8",
);
await writeFile(path.join(deployment, "control.mjs"), stripTypeScriptTypes(ts));
await writeFile(
  path.join(deployment, "server.mjs"),
  `
import { createServer } from "node:http";
import { GET } from "./control.mjs";
const server = createServer(async (req, res) => {
  const request = new Request("http://"+req.headers.host+req.url, {method:req.method, headers:req.headers});
  const result = await GET(request);
  res.writeHead(result.status,Object.fromEntries(result.headers));
  res.end(Buffer.from(await result.arrayBuffer()));
});
server.listen(Number(process.env.PORT),"127.0.0.1",()=> console.log("Listening on http://127.0.0.1:"+server.address().port));
`,
);
const modes = ["farm-ts", "farm-wasm", "direct-ts", "direct-wasi", "farm-ts-repeat"];
const expected = new Map([
  [2, 0],
  [10, 4],
  [10000, 1229],
  [100000, 9592],
]);
const median = (xs) => {
  const s = xs.toSorted((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
};
const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
async function port() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function start(mode) {
  const selected = await port();
  const direct = mode === "direct-wasi";
  const addr = "127.0.0.1:" + selected;
  const args = direct
    ? [
        "serve",
        "-S",
        "cli=y",
        "--addr",
        addr,
        "--max-concurrent-requests",
        "1",
        "--max-instance-reuse-count",
        "128",
        "wasi/api/primes/route.wasm",
      ]
    : [mode === "direct-ts" ? "server.mjs" : "node/server/index.mjs"];
  if (smokeOnly && !direct) {
    args.unshift("--permission", "--allow-fs-read=" + deployment);
  }
  const started = performance.now();
  const child = spawn(direct ? "wasmtime" : process.execPath, args, {
    cwd: deployment,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_DISABLE_COMPILE_CACHE: "1",
      HOST: "127.0.0.1",
      PORT: String(selected),
    },
  });
  const exited = once(child, "exit");
  let output = "";
  const ready = new Promise((resolve, reject) => {
    function read(chunk) {
      output += chunk.toString();
      if (output.includes("http://" + addr)) resolve();
    }
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    exited.then(
      ([code, signal]) => reject(Error(mode + " quit " + code + " " + signal + " " + output)),
      reject,
    );
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Server ${mode} did not announce ${addr}. ${output}`)),
          30_000,
        );
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { origin: "http://" + addr, mode, started, close };
}
function route(server, limit) {
  return (
    server.origin +
    "/api/" +
    (server.mode.startsWith("farm-ts") ? "primes-ts" : "primes") +
    "?limit=" +
    limit
  );
}
async function request(server, limit) {
  const response = await fetch(route(server, limit));
  const body = await response.text();
  assert.equal(response.status, 200, server.mode + ": " + body);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(body, JSON.stringify({ limit, primes: expected.get(limit) }));
}
async function load(server, limit, connections, ms) {
  const times = [],
    started = performance.now();
  async function worker() {
    do {
      const t = performance.now();
      await request(server, limit);
      times.push(performance.now() - t);
    } while (performance.now() < started + ms);
  }
  await Promise.all(Array.from({ length: connections }, worker));
  const elapsed = performance.now() - started;
  times.sort((a, b) => a - b);
  return {
    n: times.length,
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    rps: (1000 * times.length) / elapsed,
  };
}
const report = {
  environment: {
    node: process.version,
    wasmtime: spawnSync("wasmtime", ["--version"], { encoding: "utf8" }).stdout.trim(),
    cpu: os.cpus()[0].model,
    os: os.release(),
    startLoad: os.loadavg(),
  },
  settings: { rounds: 10, warmMs: 500, sampleMs: 1500, coldRounds: 20 },
  warm: [],
  cold: [],
};
const save = () =>
  writeFile(path.resolve(build, "results.json"), JSON.stringify(report, null, 2) + "\n");
const servers = new Map();
try {
  for (const mode of modes) {
    const server = await start(mode);
    servers.set(mode, server);
    for (const limit of expected.keys()) await request(server, limit);
    if (mode === "farm-wasm" || mode === "direct-wasi") {
      const r = await fetch(route(server, 10), { method: "POST" });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get("allow"), "GET");
      await r.text();
    }
  }
  console.log("All isolated artifacts passed status, body and header checks.");
  const cases = [
    { limit: 2, c: 1 },
    { limit: 100000, c: 1 },
    { limit: 2, c: 10 },
    { limit: 100000, c: 10 },
  ];
  for (let i = 0; !smokeOnly && i < report.settings.rounds; i++) {
    const order = modes.map((_, j) => modes[(j + i) % modes.length]);
    if (i >= modes.length) order.reverse();
    for (const { limit, c } of i % 2 ? cases.toReversed() : cases)
      for (const mode of order) {
        const s = servers.get(mode);
        const warm = await load(s, limit, c, report.settings.warmMs);
        report.warm.push({
          round: i + 1,
          mode,
          limit,
          c,
          warm: warm.n,
          ...(await load(s, limit, c, report.settings.sampleMs)),
        });
      }
    await save();
    console.log("Warm round", i + 1);
  }
} finally {
  await Promise.all([...servers.values()].map((s) => s.close()));
}
if (smokeOnly) {
  await rm(deployment, { recursive: true });
  process.exit(0);
}
for (let i = 0; i < report.settings.coldRounds; i++) {
  for (let j = 0; j < modes.length; j++) {
    const mode = modes[(i + j) % modes.length],
      s = await start(mode);
    try {
      await request(s, 10);
      report.cold.push({ round: i + 1, mode, ms: performance.now() - s.started });
    } finally {
      await s.close();
    }
  }
}
report.environment.endLoad = os.loadavg();
await save();
for (const limit of [2, 100000])
  for (const c of [1, 10])
    for (const mode of modes) {
      const rows = report.warm.filter((r) => r.limit === limit && r.c === c && r.mode === mode);
      console.log(
        mode,
        limit,
        c,
        ...["p50", "p95", "rps"].map((k) => median(rows.map((r) => r[k])).toFixed(3)),
      );
    }

await rm(deployment, { recursive: true });
