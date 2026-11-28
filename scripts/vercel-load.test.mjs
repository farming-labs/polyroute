import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { POST, load } from "../probes/lambda/load-function.mjs";

async function server(t, handler) {
  const listener = http.createServer(handler).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  t.after(() => listener.closeAllConnections());
  return `http://127.0.0.1:${listener.address().port}`;
}

const spec = { path: "/api/work", body: "done\n", connections: 2, durationMs: 300, warmupMs: 50 };

test("A load run counts checked responses and the guest time native functions report", async (t) => {
  let first = true;
  const origin = await server(t, (req, res) => {
    const startup = 'prefetch;dur=1.00, wait;dur=8.50, cpu;desc="Test \\"CPU\\", 2.90GHz", ';
    const timing = (first ? startup : "") + "call;dur=0.70";
    first = false;
    res.writeHead(200, { "server-timing": timing }).end("done\n");
  });
  const result = await load({ origin, spec });
  assert.ok(result.requestsPerSecond > 0);
  assert.ok(result.p50Ms <= result.p95Ms && result.p95Ms <= result.p99Ms);
  assert.equal(result.callP50Ms, 0.7);
  assert.deepEqual(result.instanceWaits, [8.5]);
  assert.deepEqual(result.instanceCpus, ['Test "CPU", 2.90GHz']);
  assert.deepEqual(result.errors, {});
});

test("A load run records a null processor for an instance that names none", async (t) => {
  let first = true;
  const origin = await server(t, (req, res) => {
    const timing = (first ? "wait;dur=3.00, " : "") + "call;dur=0.70";
    first = false;
    res.writeHead(200, { "server-timing": timing }).end("done\n");
  });
  const result = await load({ origin, spec });
  assert.deepEqual(result.instanceWaits, [3]);
  assert.deepEqual(result.instanceCpus, [null]);
});

test("A load run counts 503 responses as errors and keeps going", async (t) => {
  let count = 0;
  const origin = await server(t, (req, res) => {
    if (++count % 2 === 0) res.writeHead(503).end("busy");
    else res.end("done\n");
  });
  const result = await load({ origin, spec });
  assert.ok(result.requestsPerSecond > 0);
  assert.ok(result.errors[503] > 0);
});

test("A load run stops on a wrong body or an unexpected status", async (t) => {
  const wrong = await server(t, (req, res) => res.end("other\n"));
  assert.match((await load({ origin: wrong, spec })).failure, /unexpected body: other/);
  const missing = await server(t, (req, res) => res.writeHead(404).end("missing"));
  assert.match((await load({ origin: missing, spec })).failure, /returned 404: missing/);
});

test("A load run that loses its connection is aborted instead of retried at once", async (t) => {
  const origin = await server(t, (req) => req.socket.destroy());
  assert.deepEqual(await load({ origin, spec }), { aborted: "ECONNRESET" });
});

test("The deployed load function refuses requests without the bypass secret", async (t) => {
  const origin = await server(t, (req, res) => res.end("done\n"));
  const previous = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previous;
  });
  const post = (headers, body = spec) =>
    POST(
      new Request(`${origin}/api/load`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  assert.equal((await post({ "x-polyroute-load-secret": "" })).status, 403);
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "secret";
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "x-polyroute-load-secret": "wrong" })).status, 403);
  const headers = { "x-polyroute-load-secret": "secret" };
  assert.equal((await post(headers, { ...spec, path: "https://elsewhere.example/" })).status, 400);
  assert.equal((await post(headers, { ...spec, connections: 500 })).status, 400);
  const response = await post(headers);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.requestsPerSecond > 0);
  // Linux names the processor in `/proc/cpuinfo`; other systems report none.
  if (process.platform === "linux") assert.equal(typeof result.generatorCpuModel, "string");
  else assert.equal(result.generatorCpuModel, null);
});
