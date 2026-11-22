// Sends sustained load to one function and reports what it measured.
// `measure-vercel-load.mjs` calls `load` from the client, and
// `build-vercel-output.mjs` deploys this file as `/api/load`, whose `POST`
// runs the same load from inside the deployment's region.
//
// `connections` clients send requests back to back over kept-alive
// connections. Requests that finish inside the `durationMs` window after
// `warmupMs` count. Every 200 response's body is checked.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

// Under load the provider may refuse or fail a request; those are counted and
// reported. Any other status means the run is misconfigured, so it stops.
const loadStatuses = new Set([429, 500, 502, 503, 504]);

function send(agent, url, spec, headers) {
  const body = spec.send === undefined ? undefined : Buffer.from(spec.send);
  const requestHeaders = { ...headers };
  if (body) {
    requestHeaders["content-type"] = "application/json";
    requestHeaders["content-length"] = body.length;
  }
  const client = url.protocol === "https:" ? https : http;
  const started = performance.now();
  return new Promise((resolve) => {
    const failed = (error) =>
      resolve({ ms: performance.now() - started, error: error.code ?? error.message });
    const request = client.request(
      url,
      { agent, method: spec.method ?? "GET", headers: requestHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", failed);
        res.on("end", () =>
          resolve({
            ms: performance.now() - started,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString(),
            timing: res.headers["server-timing"],
          }),
        );
      },
    );
    request.on("error", failed);
    request.end(body);
  });
}

/**
 * Runs one load run and returns its requests per second, latency percentiles
 * and errors. A request that gets no response at all says nothing about the
 * function, and clients that retried at once would turn one dropped network
 * into thousands of errors, so the run stops and returns `{ aborted }`. A
 * status the provider wouldn't send under load, or a wrong body, returns
 * `{ failure }`.
 */
export async function load({ origin, spec, headers = {} }) {
  const url = new URL(spec.path, origin);
  // Resolve the host once per run, so reconnecting doesn't query DNS each time.
  const { address, family } = await lookup(url.hostname, { family: 4 });
  const agent = new (url.protocol === "https:" ? https : http).Agent({
    keepAlive: true,
    maxSockets: spec.connections,
    lookup: (_hostname, options, callback) =>
      options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
  });
  let aborted;
  let failure;
  const latencies = [];
  const calls = [];
  const result = { errors: {}, warmupErrors: {}, instanceWaits: [] };
  const cpu = process.cpuUsage();
  const start = performance.now();
  const from = start + spec.warmupMs;
  const to = from + spec.durationMs;
  async function worker() {
    while (aborted === undefined && failure === undefined && performance.now() < to) {
      const r = await send(agent, url, spec, headers);
      const end = performance.now();
      const counted = end >= from && end <= to;
      if (r.error !== undefined) {
        aborted ??= r.error;
        break;
      }
      if (r.status !== 200) {
        if (!loadStatuses.has(r.status)) {
          failure ??= `${spec.path} returned ${r.status}: ${r.text.slice(0, 200)}`;
          break;
        }
        const errors = counted ? result.errors : result.warmupErrors;
        errors[r.status] = (errors[r.status] ?? 0) + 1;
        continue;
      }
      if (r.text !== spec.body) {
        failure ??= `${spec.path} returned an unexpected body: ${r.text.slice(0, 200)}`;
        break;
      }
      // Native functions built with `serverTiming` report `call` on every
      // response, and each instance reports `wait` on its first one.
      const phases = r.timing
        ? Object.fromEntries(
            [...r.timing.matchAll(/(\w+);dur=([\d.]+)/g)].map(([, name, ms]) => [name, Number(ms)]),
          )
        : undefined;
      if (phases?.wait !== undefined) result.instanceWaits.push(phases.wait);
      if (!counted) continue;
      latencies.push(r.ms);
      if (phases?.call !== undefined) calls.push(phases.call);
    }
  }
  await Promise.all(Array.from({ length: spec.connections }, worker));
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  agent.destroy();
  if (failure !== undefined) return { failure };
  if (aborted !== undefined) return { aborted };
  const at = (values, q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  latencies.sort((a, b) => a - b);
  calls.sort((a, b) => a - b);
  return {
    requestsPerSecond: latencies.length / (spec.durationMs / 1000),
    p50Ms: at(latencies, 0.5),
    p95Ms: at(latencies, 0.95),
    p99Ms: at(latencies, 0.99),
    // The guest's own time per request, from native functions' `call`.
    callP50Ms: at(calls, 0.5),
    // The load generator's CPU time over the run's wall time. Near 1, the
    // generator rather than the function limited the rate.
    generatorCpu: (used.user + used.system) / 1000 / elapsed,
    ...result,
  };
}

/**
 * Runs one load run against this deployment from inside its region. Preview
 * protection needs `x-vercel-protection-bypass`; the caller repeats the same
 * secret in `x-polyroute-load-secret`, which this function checks, so a
 * deployment without protection can't be made to load itself either.
 */
export async function POST(request) {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret || request.headers.get("x-polyroute-load-secret") !== secret)
    return new Response("Forbidden\n", { status: 403 });
  const spec = await request.json();
  const valid =
    typeof spec.path === "string" &&
    spec.path.startsWith("/api/") &&
    typeof spec.body === "string" &&
    Number.isInteger(spec.connections) &&
    spec.connections > 0 &&
    spec.connections <= 200 &&
    spec.durationMs > 0 &&
    spec.warmupMs >= 0 &&
    spec.durationMs + spec.warmupMs <= 60_000;
  if (!valid)
    return Response.json(
      {
        error:
          "Send path (under /api/), body, connections (1 to 200), durationMs and warmupMs (60 s in total at most).",
      },
      { status: 400 },
    );
  const origin = new URL(request.url).origin;
  const result = await load({ origin, spec, headers: { "x-vercel-protection-bypass": secret } });
  return Response.json(result);
}
