#!/usr/bin/env node
// Measures every route of the example app's production build over real HTTP.
// Each response body is checked, so a fast wrong answer counts as an error.
//
//   node scripts/bench.mjs                      build the example, then measure it
//   node scripts/bench.mjs --baseline <file>    also measure another build of
//                                               dist/server.js, alternating rounds
//   node scripts/bench.mjs --no-build --rounds 5 --duration 5 --connections 10
//   node scripts/bench.mjs --cold --rounds 10   time from starting a fresh server
//                                               to each route's first response
//
// Pass this build's own dist/server.js as --baseline to measure run-to-run noise.

import { spawn, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values: flags } = parseArgs({
  options: {
    baseline: { type: "string" },
    build: { type: "boolean", default: true },
    cold: { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    rounds: { type: "string", default: "3" },
    duration: { type: "string", default: "5" },
    warmup: { type: "string", default: "1" },
    connections: { type: "string", default: "10" },
    route: { type: "string", multiple: true },
  },
});

function positiveNumber(flag) {
  const value = Number(flags[flag]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`\`--${flag}\` must be a positive number, got \`${flags[flag]}\`.`);
    process.exit(2);
  }
  return value;
}

const rounds = positiveNumber("rounds");
const durationMs = positiveNumber("duration") * 1000;
const warmupMs = positiveNumber("warmup") * 1000;
const connections = positiveNumber("connections");

const routes = [
  {
    name: "TypeScript",
    path: "/api/hello",
    body: '{"message":"Hello from TypeScript"}',
  },
  {
    name: "Rust (little work)",
    path: "/api/primes?limit=2",
    body: '{"limit":2,"primes":0}',
  },
  {
    name: "Rust (primes to 10,000)",
    path: "/api/primes?limit=10000",
    body: '{"limit":10000,"primes":1229}',
  },
  {
    name: "Go",
    path: "/api/slug?text=hello",
    body: '{"slug":"hello","text":"hello"}\n',
  },
  {
    name: "Python",
    path: "/api/stats",
    method: "POST",
    send: "[1, 2, 3, 4]",
    body: '{"count":4,"mean":2.5,"median":2.5}',
  },
].filter((route) => flags.route === undefined || flags.route.includes(route.name));

if (routes.length === 0) {
  console.error("No route matches `--route`. Use a name from the results table.");
  process.exit(2);
}

function startServer(file) {
  const child = spawn(process.execPath, [file], {
    cwd: path.dirname(path.dirname(file)),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const origin = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.on("exit", (code) =>
      reject(new Error(`${file} exited with ${code} before it was ready.`)),
    );
  });
  return { child, origin };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

async function request(origin, route) {
  const response = await fetch(`${origin}${route.path}`, {
    method: route.method ?? "GET",
    body: route.send,
  });
  const body = await response.text();
  return response.status === 200 && body === route.body;
}

/** Runs `connections` closed loops against one route for `ms` milliseconds. */
async function load(origin, route, ms) {
  const latencies = [];
  let errors = 0;
  const deadline = performance.now() + ms;
  const worker = async () => {
    while (performance.now() < deadline) {
      const started = performance.now();
      const ok = await request(origin, route).catch(() => false);
      latencies.push(performance.now() - started);
      if (!ok) errors++;
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: connections }, worker));
  const elapsed = performance.now() - started;
  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  return {
    rps: (latencies.length / elapsed) * 1000,
    p50: at(0.5),
    p99: at(0.99),
    errors,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

if (flags.build && !flags["no-build"]) {
  for (const filter of ["@farming-labs/polyroute", "polyroute-example-polyglot"]) {
    const result = spawnSync("pnpm", ["--filter", filter, "build"], {
      cwd: repo,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) process.exit(1);
  }
}

const builds = [{ label: "current", file: path.join(repo, "examples/polyglot/dist/server.js") }];
if (flags.baseline !== undefined) {
  builds.unshift({ label: "baseline", file: path.resolve(flags.baseline) });
}

const environment = `${cpus()[0]?.model ?? "unknown CPU"}, ${process.platform} ${process.arch}, Node ${process.versions.node}.`;

if (flags.cold) {
  // Each sample starts a new server process and sends one request, the way a
  // serverless instance handles its first request.
  const samples = new Map();
  for (let round = 1; round <= rounds; round++) {
    for (const route of routes) {
      const order = round % 2 === 1 ? builds : [...builds].reverse();
      for (const build of order) {
        const started = performance.now();
        const { child, origin } = startServer(build.file);
        let ok;
        try {
          ok = await request(await origin, route);
        } finally {
          await stopServer(child);
        }
        const ms = performance.now() - started;
        if (!ok) {
          console.error(`${build.label}: ${route.name} didn't answer 200 with the expected body.`);
          process.exit(1);
        }
        const key = `${route.name}\0${build.label}`;
        samples.set(key, [...(samples.get(key) ?? []), ms]);
        console.error(
          `round ${round}/${rounds}  ${build.label.padEnd(8)}  ${route.name.padEnd(24)}  ${Math.round(ms)} ms`,
        );
      }
    }
  }
  console.log(
    `\n${environment} Time from starting a new server to the first response, ${rounds} runs per route and build. Median of runs.\n`,
  );
  console.log("| Route | Build | Cold start | range |");
  console.log("| --- | --- | ---: | ---: |");
  for (const route of routes) {
    for (const build of builds) {
      const ms = samples.get(`${route.name}\0${build.label}`) ?? [];
      const range = `${Math.round(Math.min(...ms))}–${Math.round(Math.max(...ms))} ms`;
      console.log(`| ${route.name} | ${build.label} | ${Math.round(median(ms))} ms | ${range} |`);
    }
  }
  process.exit(0);
}

const servers = await Promise.all(
  builds.map(async (build) => {
    const { child, origin } = startServer(build.file);
    return { ...build, child, origin: await origin };
  }),
);

const results = new Map();
let failed = false;
try {
  for (const server of servers) {
    for (const route of routes) {
      if (!(await request(server.origin, route))) {
        throw new Error(`${server.label}: ${route.name} didn't answer 200 with the expected body.`);
      }
    }
  }
  for (let round = 1; round <= rounds; round++) {
    for (const route of routes) {
      // Alternate which build goes first, so neither always runs on a warmer machine.
      const order = round % 2 === 1 ? servers : [...servers].reverse();
      for (const server of order) {
        await load(server.origin, route, warmupMs);
        const result = await load(server.origin, route, durationMs);
        const key = `${route.name}\0${server.label}`;
        results.set(key, [...(results.get(key) ?? []), result]);
        console.error(
          `round ${round}/${rounds}  ${server.label.padEnd(8)}  ${route.name.padEnd(24)}  ${Math.round(result.rps)} req/s`,
        );
      }
    }
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await Promise.all(servers.map((server) => stopServer(server.child)));
}
if (failed) process.exit(1);

const formatMs = (ms) => (ms < 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);
console.log(
  `\n${environment} ` +
    `${connections} connections, ${rounds} rounds of ${durationMs / 1000} s per route and build after a ${warmupMs / 1000} s warmup. Median of rounds.\n`,
);
const header = ["Route", "Build", "req/s", "range", "p50", "p99", "errors"];
console.log(`| ${header.join(" | ")} |`);
console.log(`| ${header.map((_, index) => (index < 2 ? "---" : "---:")).join(" | ")} |`);
for (const route of routes) {
  for (const server of servers) {
    const runs = results.get(`${route.name}\0${server.label}`) ?? [];
    const rps = runs.map((run) => run.rps);
    const row = [
      route.name,
      server.label,
      Math.round(median(rps)).toLocaleString("en-US"),
      `${Math.round(Math.min(...rps)).toLocaleString("en-US")}–${Math.round(Math.max(...rps)).toLocaleString("en-US")}`,
      formatMs(median(runs.map((run) => run.p50))),
      formatMs(median(runs.map((run) => run.p99))),
      String(runs.reduce((sum, run) => sum + run.errors, 0)),
    ];
    console.log(`| ${row.join(" | ")} |`);
  }
}
if ([...results.values()].flat().some((run) => run.errors > 0)) process.exit(1);
