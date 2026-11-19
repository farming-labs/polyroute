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
//   node scripts/bench.mjs --matched --json    include TypeScript counterparts
//                                               and retain every round as JSON
//   node scripts/bench.mjs --server <file>     use an already-built server
//
// Pass this build's own dist/server.js as --baseline to measure run-to-run noise.

import { spawn, spawnSync } from "node:child_process";
import { cpus, loadavg, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { measureColdStart } from "./cold-start.mjs";
import { benchmarkRoutes } from "./bench-routes.mjs";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values: flags } = parseArgs({
  options: {
    baseline: { type: "string" },
    server: { type: "string" },
    matched: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
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

function positiveNumber(flag, integer = false) {
  const value = Number(flags[flag]);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    console.error(
      `\`--${flag}\` must be a positive ${integer ? "integer" : "number"}, got \`${flags[flag]}\`.`,
    );
    process.exit(2);
  }
  return value;
}

const rounds = positiveNumber("rounds", true);
const durationMs = positiveNumber("duration") * 1000;
const warmupMs = positiveNumber("warmup") * 1000;
const connections = positiveNumber("connections", true);

const availableRoutes = benchmarkRoutes.filter((route) => flags.matched || !route.matchedOnly);
const unknownRoutes =
  flags.route?.filter((name) => !availableRoutes.some((route) => route.name === name)) ?? [];
if (unknownRoutes.length > 0) {
  console.error(
    `Unknown \`--route\`: ${unknownRoutes.join(", ")}. Use a name from the results table and enable \`--matched\` for paired workloads.`,
  );
  process.exit(2);
}
const routes = benchmarkRoutes.filter(
  (route) =>
    (flags.matched || !route.matchedOnly) &&
    (flags.route === undefined || flags.route.includes(route.name)),
);

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
    child.once("error", reject);
  });
  return { child, origin };
}

async function stopServer(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
  if (latencies.length === 0) {
    throw new Error("No requests completed. Increase `--duration` and `--warmup`.");
  }
  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)];
  return {
    rps: (latencies.length / elapsed) * 1000,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    errors,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

if (flags.server === undefined && flags.build && !flags["no-build"]) {
  for (const filter of ["@farming-labs/polyroute", "polyroute-example-polyglot"]) {
    const result = spawnSync("pnpm", ["--filter", filter, "build"], {
      cwd: repo,
      stdio: flags.json ? ["inherit", 2, 2] : "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) process.exit(1);
  }
}

const builds = [
  {
    label: "current",
    file: path.resolve(flags.server ?? path.join(repo, "examples/polyglot/dist/server.js")),
  },
];
if (flags.baseline !== undefined) {
  builds.unshift({ label: "baseline", file: path.resolve(flags.baseline) });
}

const environmentDetails = {
  cpu: cpus()[0]?.model ?? "unknown CPU",
  logicalCpus: cpus().length,
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  node: process.versions.node,
  loadAverageStart: loadavg(),
};
const environment = `${environmentDetails.cpu}, ${process.platform} ${process.arch}, Node ${process.versions.node}.`;
const report = (mode, results) => ({
  schemaVersion: 1,
  mode,
  environment: { ...environmentDetails, loadAverageEnd: loadavg() },
  settings: { rounds, durationMs, warmupMs, connections, matched: flags.matched },
  builds,
  samplesDiscarded: 0,
  results,
});
const routeOrder = (round) => (round % 2 === 1 ? routes : [...routes].reverse());

if (flags.cold) {
  // Each sample starts a new server process and sends one request, the way a
  // serverless instance handles its first request.
  const samples = new Map();
  for (let round = 1; round <= rounds; round++) {
    for (const route of routeOrder(round)) {
      const order = round % 2 === 1 ? builds : [...builds].reverse();
      for (const build of order) {
        const { ok, ms } = await measureColdStart({
          start: () => startServer(build.file),
          request: (origin) => request(origin, route),
          stop: stopServer,
        });
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
  const results = routes.flatMap((route) =>
    builds.map((build) => {
      const ms = samples.get(`${route.name}\0${build.label}`);
      return {
        route: route.name,
        language: route.language,
        workload: route.workload,
        build: build.label,
        samplesMs: ms,
        medianMs: median(ms),
        p95Ms: percentile(ms, 0.95),
        minMs: Math.min(...ms),
        maxMs: Math.max(...ms),
      };
    }),
  );
  if (flags.json) {
    console.log(JSON.stringify(report("cold", results), null, 2));
    process.exit(0);
  }
  console.log(
    `\n${environment} Time from starting a new server to the first verified response, ${rounds} runs per route and build. Cleanup excluded. No samples were discarded.\n`,
  );
  console.log("| Route | Build | Cold start (median) | p95 | range |");
  console.log("| --- | --- | ---: | ---: | ---: |");
  for (const result of results) {
    const range = `${Math.round(result.minMs)}–${Math.round(result.maxMs)} ms`;
    console.log(
      `| ${result.route} | ${result.build} | ${Math.round(result.medianMs)} ms | ${Math.round(result.p95Ms)} ms | ${range} |`,
    );
  }
  process.exit(0);
}

let servers = builds.map((build) => ({ ...build, ...startServer(build.file) }));

const results = new Map();
let failed = false;
try {
  servers = await Promise.all(
    servers.map(async (server) => ({ ...server, origin: await server.origin })),
  );
  for (const server of servers) {
    for (const route of routes) {
      if (!(await request(server.origin, route))) {
        throw new Error(`${server.label}: ${route.name} didn't answer 200 with the expected body.`);
      }
    }
  }
  for (let round = 1; round <= rounds; round++) {
    for (const route of routeOrder(round)) {
      // Alternate which build goes first, so neither always runs on a warmer machine.
      const order = round % 2 === 1 ? servers : [...servers].reverse();
      for (const server of order) {
        const warmup = await load(server.origin, route, warmupMs);
        const result = await load(server.origin, route, durationMs);
        result.round = round;
        result.warmupErrors = warmup.errors;
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

const summaries = routes.flatMap((route) =>
  builds.map((build) => {
    const runs = results.get(`${route.name}\0${build.label}`);
    const rps = runs.map((run) => run.rps);
    return {
      route: route.name,
      language: route.language,
      workload: route.workload,
      build: build.label,
      rounds: runs,
      medianRps: median(rps),
      minRps: Math.min(...rps),
      maxRps: Math.max(...rps),
      medianP50Ms: median(runs.map((run) => run.p50Ms)),
      medianP95Ms: median(runs.map((run) => run.p95Ms)),
      medianP99Ms: median(runs.map((run) => run.p99Ms)),
      errors: runs.reduce((sum, run) => sum + run.errors + run.warmupErrors, 0),
    };
  }),
);
const errors = summaries.some((result) => result.errors > 0);
if (flags.json) {
  console.log(JSON.stringify(report("throughput", summaries), null, 2));
  process.exit(errors ? 1 : 0);
}

const formatMs = (ms) => (ms < 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);
console.log(
  `\n${environment} ` +
    `${connections} connections, ${rounds} rounds of ${durationMs / 1000} s per route and build after a ${warmupMs / 1000} s warmup. Median of rounds. No samples were discarded.\n`,
);
const header = [
  "Route",
  "Build",
  "req/s",
  "range",
  "p50",
  "p95",
  "p99",
  "errors (including warmup)",
];
console.log(`| ${header.join(" | ")} |`);
console.log(`| ${header.map((_, index) => (index < 2 ? "---" : "---:")).join(" | ")} |`);
for (const result of summaries) {
  const row = [
    result.route,
    result.build,
    Math.round(result.medianRps).toLocaleString("en-US"),
    `${Math.round(result.minRps).toLocaleString("en-US")}–${Math.round(result.maxRps).toLocaleString("en-US")}`,
    formatMs(result.medianP50Ms),
    formatMs(result.medianP95Ms),
    formatMs(result.medianP99Ms),
    String(result.errors),
  ];
  console.log(`| ${row.join(" | ")} |`);
}
if (errors) process.exit(1);
