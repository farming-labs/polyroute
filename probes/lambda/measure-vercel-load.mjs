// Measures sustained requests per second on Vercel against deployments that
// `measure-vercel-cold.mjs` created. For each deployment and connection count,
// every function runs in turn through `load-function.mjs`: from this client,
// or with `--from vercel` from the deployment's own `/api/load` function,
// inside its region. `/api/warmup`, a Node function that does no work, runs
// first and last at each connection count as an A/A control. The order
// rotates with each deployment and reverses at every other connection count.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { load } from "./load-function.mjs";

const { values } = parseArgs({
  options: {
    deployments: { type: "string" },
    functions: { type: "string" },
    from: { type: "string", default: "client" },
    connections: { type: "string", default: "1,10,50" },
    duration: { type: "string", default: "8" },
    warmup: { type: "string", default: "2" },
    output: { type: "string" },
  },
});
for (const key of ["deployments", "output"]) {
  if (!values[key])
    throw new Error(
      `Provide --${key}. --deployments is the deployments.json measure-vercel-cold.mjs wrote, --output a new directory.`,
    );
}
if (!["client", "vercel"].includes(values.from))
  throw new Error("--from must be client or vercel.");
const levels = values.connections.split(",").map(Number);
if (!levels.every((n) => Number.isInteger(n) && n > 0))
  throw new Error("--connections must be whole numbers separated by commas, such as 1,10,50.");
const durationMs = Number(values.duration) * 1000;
const warmupMs = Number(values.warmup) * 1000;
if (!(durationMs > 0 && warmupMs >= 0))
  throw new Error("--duration must be positive and --warmup at least 0.");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (values.from === "vercel" && !bypass)
  throw new Error(
    "Set VERCEL_AUTOMATION_BYPASS_SECRET to the project's Protection Bypass for Automation secret; --from vercel needs it.",
  );

const primes = '{"limit":10000,"primes":1229}';
const slug = '{"slug":"hello","text":"hello"}\n';
const stats = '{"count":4,"mean":2.5,"median":2.5}';
const post = { method: "POST", send: "[1, 2, 3, 4]" };
const functions = values.functions
  ? JSON.parse(await readFile(values.functions, "utf8"))
  : [
      { name: "rust", path: "/api/primes?limit=10000", body: primes },
      { name: "go", path: "/api/slug?text=hello", body: slug },
      { name: "python", path: "/api/stats", body: stats, ...post },
      { name: "ts-primes", path: "/api/primes-ts?limit=10000", body: primes },
      { name: "ts-slug", path: "/api/slug-ts?text=hello", body: slug },
      { name: "ts-stats", path: "/api/stats-ts", body: stats, ...post },
    ];
const control = { path: "/api/warmup", body: "warm\n" };
const deployments = JSON.parse(await readFile(values.deployments, "utf8"));
const output = path.resolve(values.output);
await mkdir(output);
const samplesFile = path.join(output, "samples.ndjson");
// A run that loses its connection is recorded as aborted and runs again.
const attempts = 3;

async function run(url, fn, connections) {
  const spec = { ...fn, connections, durationMs, warmupMs };
  delete spec.name;
  if (values.from === "client") {
    const headers = bypass ? { "x-vercel-protection-bypass": bypass } : {};
    return load({ origin: url, spec, headers });
  }
  let response;
  try {
    response = await fetch(new URL("/api/load", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-protection-bypass": bypass,
        "x-polyroute-load-secret": bypass,
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(durationMs + warmupMs + 60_000),
    });
  } catch (error) {
    return { aborted: `/api/load: ${error.cause?.code ?? error.message}` };
  }
  const text = await response.text();
  if (response.status !== 200) return { failure: `/api/load returned ${response.status}: ${text}` };
  return JSON.parse(text);
}

for (const [round, { id, url }] of deployments.entries()) {
  const shift = round % functions.length;
  const rotated = [...functions.slice(shift), ...functions.slice(0, shift)];
  for (const [level, connections] of levels.entries()) {
    const order = level % 2 === 0 ? rotated : [...rotated].reverse();
    const sequence = [
      { ...control, name: "control-first" },
      ...order,
      { ...control, name: "control-last" },
    ];
    for (const [position, fn] of sequence.entries()) {
      const label = `${round + 1}/${deployments.length} c=${connections} ${fn.name}`;
      for (let attempt = 1; ; attempt++) {
        const r = await run(url, fn, connections);
        const sample = { round, deployment: id, connections, position, name: fn.name, attempt };
        await appendFile(
          samplesFile,
          JSON.stringify({ ...sample, from: values.from, durationMs, warmupMs, ...r }) + "\n",
        );
        if (r.failure !== undefined) throw new Error(`${label}: ${r.failure}`);
        if (r.aborted === undefined) {
          const errors = Object.values(r.errors).reduce((sum, n) => sum + n, 0);
          console.log(
            `${label}: ${r.requestsPerSecond.toFixed(1)} req/s, p50 ${r.p50Ms?.toFixed(1)} ms, errors ${errors}`,
          );
          break;
        }
        console.log(`${label}: aborted after ${r.aborted}`);
        if (attempt === attempts)
          throw new Error(
            `${label} lost its connection in ${attempts} runs in a row (${r.aborted}). Check the network, then rerun with a new --output.`,
          );
      }
    }
  }
}
