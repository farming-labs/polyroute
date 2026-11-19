import assert from "node:assert/strict";
import { bounded, deferred, event } from "./protocol.mjs";
import { runCases } from "./cases.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: { fixtures: { type: "string" }, binary: { type: "string" }, output: { type: "string" } },
});
for (const key of ["fixtures", "binary", "output"]) {
  if (!values[key]) throw new Error(`Missing --${key}; provide the explicit probe path.`);
}
const root = path.resolve(values.output) + path.sep;
const binary = path.resolve(values.binary);
await mkdir(root);
const fixtures = JSON.parse(await readFile(values.fixtures));
const report = {
  started: new Date().toISOString(),
  tests: [],
  failures: [],
  invocations: 0,
  acknowledgements: {},
  outcomes: {},
};
let sequence = 0;
async function check(name, fn) {
  try {
    await fn();
    report.tests.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: error.stack });
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
async function start(manifest, { ackStatus = 202 } = {}) {
  const ready = deferred(),
    ended = deferred();
  const queue = [],
    active = new Map();
  let waiter,
    stderr = "",
    stdout = "",
    closed = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/2018-06-01/runtime/invocation/next") {
        assert.equal(waiter, undefined, "only one pending next request");
        waiter = res;
        ready.resolve();
        deliver();
        return;
      }
      const match = /^\/2018-06-01\/runtime\/invocation\/([^/]+)\/(response|error)$/.exec(req.url);
      assert.equal(req.method, "POST");
      assert.ok(match, req.url);
      const item = active.get(match[1]);
      assert.ok(item, "unknown invocation");
      let body = "";
      for await (const c of req) body += c;
      const parsed = JSON.parse(body);
      active.delete(match[1]);
      report.invocations++;
      report.acknowledgements[ackStatus] = (report.acknowledgements[ackStatus] ?? 0) + 1;
      report.outcomes[match[2]] = (report.outcomes[match[2]] ?? 0) + 1;
      res.writeHead(ackStatus);
      res.end();
      item.resolve({ kind: match[2], value: parsed });
    } catch (error) {
      res.writeHead(500);
      res.end();
      for (const item of active.values()) item.reject(error);
      ready.reject(error);
    }
  });
  function deliver() {
    if (!waiter || !queue.length) return;
    const item = queue.shift();
    active.set(item.id, item);
    const res = waiter;
    waiter = undefined;
    res.writeHead(200, {
      "content-type": "application/json",
      "lambda-runtime-aws-request-id": item.id,
      "lambda-runtime-deadline-ms": String(Date.now() + 60000),
      "lambda-runtime-invoked-function-arn":
        "arn:aws:lambda:us-east-1:123456789012:function:local-probe",
    });
    res.end(JSON.stringify(item.event));
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const file = `${root}manifest-${++sequence}.json`;
  await writeFile(file, JSON.stringify(manifest));
  const child = spawn(binary, [file], {
    env: {
      ...process.env,
      AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${server.address().port}`,
      AWS_LAMBDA_FUNCTION_NAME: "local-probe",
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "128",
      AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.on("error", (e) => {
    ready.reject(e);
    ended.reject(e);
  });
  child.on("exit", (code, signal) => {
    closed = true;
    ended.resolve({ code, signal });
    ready.reject(Error(`early exit ${code}/${signal}: ${stderr}`));
    for (const item of active.values()) item.reject(Error(`runtime exited: ${stderr}`));
  });
  async function stop() {
    if (!closed) child.kill("SIGTERM");
    let result;
    try {
      result = await bounded(ended.promise, "shutdown");
      assert.equal(result.code, 0, stderr);
    } finally {
      if (!closed) {
        child.kill("SIGKILL");
        await ended.promise;
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    return result;
  }
  try {
    await bounded(ready.promise, "first runtime poll");
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return {
    async logs() {
      return stderr;
    },
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    stop,
    invoke(input) {
      const d = deferred();
      queue.push({ ...d, id: `request-${++sequence}`, event: input });
      deliver();
      return bounded(d.promise, "invocation result");
    },
    async request(path, options) {
      const response = await this.invoke(event(path, options));
      if (response.kind === "error") return { status: 500, error: response.value };
      const r = response.value;
      assert.equal(typeof r.statusCode, "number");
      const bytes = Buffer.from(r.body ?? "", r.isBase64Encoded ? "base64" : "utf8");
      return {
        status: r.statusCode,
        bytes,
        text: bytes.toString(),
        headers: r.headers,
        cookies: r.cookies,
        raw: r,
      };
    },
  };
}
async function fixture(key, options, fn) {
  const host = await start({
    component: fixtures[key].component,
    requestsPerInstance: key.startsWith("go/") ? 1000 : 0,
    ...options,
  });
  try {
    await fn(host);
  } finally {
    await host.stop();
  }
}
await runCases({ fixture, check });
await check("Shutdown cancels an active outbound request", async () => {
  const arrived = deferred(),
    disconnected = deferred();
  const stalled = http.createServer((req, res) => {
    res.once("close", () => disconnected.resolve());
    arrived.resolve();
  });
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  const h = await start({
    component: fixtures["outbound/route.rs"].component,
    outboundAllow: ["127.0.0.1"],
  });
  try {
    const invoke = h
      .request("/", {
        headers: { "x-upstream": `http://127.0.0.1:${stalled.address().port}/stall` },
      })
      .then(
        () => null,
        (e) => e,
      );
    await bounded(arrived.promise, "upstream arrival");
    await h.stop();
    await bounded(disconnected.promise, "upstream cancellation");
    assert.ok(await invoke);
  } finally {
    await h.stop();
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});
await check(
  "Rejected response acknowledgement is reported and next invocation remains usable",
  async () => {
    const h = await start(
      { component: fixtures["counter/route.rs"].component },
      { ackStatus: 410 },
    );
    try {
      assert.equal((await h.request()).text, "1");
      assert.equal((await h.request()).text, "2");
    } finally {
      await h.stop();
    }
    assert.match(h.stderr, /410 Gone/);
    assert.match(h.stderr, /invocation timed out or response was stale/);
  },
);
await check("Invalid manifests fail before polling", async () => {
  for (const manifest of [
    { component: "/missing/component.cwasm" },
    { component: fixtures["counter/route.rs"].component, unexpected: true },
    { component: fixtures["counter/route.rs"].component, authority: "example.com" },
  ]) {
    const file = `${root}invalid-${++sequence}.json`;
    await writeFile(file, JSON.stringify(manifest));
    const c = spawn(binary, [file], {
      env: {
        ...process.env,
        AWS_LAMBDA_RUNTIME_API: "127.0.0.1:1",
        AWS_LAMBDA_FUNCTION_NAME: "local-probe",
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "128",
        AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    c.stderr.on("data", (b) => (stderr += b));
    const [code] = await bounded(once(c, "exit"), "invalid manifest exit");
    assert.equal(code, 1);
    assert.ok(stderr.length);
    assert.doesNotMatch(stderr, /error trying to connect/);
  }
});
report.finished = new Date().toISOString();
await writeFile(`${root}runtime-results.json`, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: report.tests.length,
    failed: report.failures.length,
    invocations: report.invocations,
  }),
);
if (report.failures.length) process.exitCode = 1;
