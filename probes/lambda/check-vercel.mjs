// Runs the shared guest cases against the Vercel binary over HTTP, with a
// local unix socket standing in for Vercel's IPC bridge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { bounded, deferred } from "./protocol.mjs";
import { runCases } from "./cases.mjs";

const { values } = parseArgs({
  options: { fixtures: { type: "string" }, binary: { type: "string" }, output: { type: "string" } },
});
for (const key of ["fixtures", "binary", "output"]) {
  if (!values[key]) throw new Error(`Provide --${key}; --output must be a new directory.`);
}
const fixtures = JSON.parse(await readFile(values.fixtures));
const binary = path.resolve(values.binary);
const output = path.resolve(values.output);
await mkdir(output);
const report = {
  started: new Date().toISOString(),
  tests: [],
  skipped: [],
  failures: [],
  requests: 0,
  endMessages: 0,
};
let sequence = 0;

class NotApplicable extends Error {}

async function check(name, fn) {
  try {
    await fn();
    report.tests.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    if (error instanceof NotApplicable) {
      report.skipped.push({ name, reason: error.message });
      console.log(`SKIP ${name}: ${error.message}`);
      return;
    }
    report.failures.push({ name, error: error.stack });
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Starts the binary behind a fake bridge. Resolves once it reports
// `server-started`, the only readiness signal Vercel uses.
async function start(manifest) {
  const index = ++sequence;
  const socketPath = path.join(output, `ipc-${index}.sock`);
  const manifestFile = path.join(output, `manifest-${index}.json`);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const started = deferred();
  const ends = new Map();
  const messages = [];
  const bridge = net.createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\0")) !== -1) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        messages.push(message);
        if (message.type === "server-started") started.resolve(message.payload.httpPort);
        if (message.type === "end") {
          report.endMessages++;
          ends.get(message.payload.context.requestId)?.resolve(message.payload);
        }
      }
    });
  });
  bridge.listen(socketPath);
  await once(bridge, "listening");
  const port = await freePort();
  const child = spawn(binary, [manifestFile], {
    env: { PATH: process.env.PATH, VERCEL_IPC_PATH: socketPath, VERCEL_DEV_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  const exited = once(child, "exit");
  exited.then(() => {
    started.reject(new Error(`The binary exited before readiness:\n${logs}`));
    if (bridge.listening) bridge.close();
  });
  const httpPort = await bounded(started.promise, "server-started message");
  assert.equal(httpPort, port);
  let requestId = 0;
  const agent = new http.Agent({ keepAlive: true });

  function send(target, { method = "GET", headers = {}, body = "", setHost = true }) {
    const id = ++requestId;
    const end = deferred();
    ends.set(id, end);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: target,
          method,
          agent,
          setHost,
          headers: {
            ...(setHost ? { host: "function.example", "x-forwarded-proto": "https" } : {}),
            "x-vercel-internal-invocation-id": `invocation-${index}`,
            "x-vercel-internal-request-id": String(id),
            ...headers,
            ...(bytes.length > 0 ? { "content-length": bytes.length } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", async () => {
            report.requests++;
            try {
              const payload = await bounded(end.promise, `end message for request ${id}`);
              assert.equal(payload.context.invocationId, `invocation-${index}`);
              assert.equal(payload.error, null);
              const data = Buffer.concat(chunks);
              resolve({
                status: res.statusCode,
                bytes: data,
                text: data.toString(),
                headers: res.headers,
                cookies: res.headers["set-cookie"],
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("The request timed out.")));
      req.end(bytes);
    });
  }

  return {
    messages,
    get logs() {
      return logs;
    },
    async request(target = "/", options = {}) {
      const headers = { ...options.headers };
      for (const [name, value] of Object.entries(headers)) {
        if ([...String(value)].some((character) => character.codePointAt(0) > 255))
          throw new NotApplicable(
            `HTTP headers are bytes, so \`${name}\` can't carry characters above U+00FF; the JSON-event check covers this.`,
          );
      }
      if (options.cookies) headers.cookie = options.cookies.join("; ");
      return send(target, { ...options, headers });
    },
    async invoke() {
      // The HTTP equivalent of a malformed event: a request with no host.
      const r = await send("/", { setHost: false });
      return { kind: r.status === 500 ? "error" : "response", value: r };
    },
    async stop(signal = "SIGTERM") {
      agent.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const [code] = await bounded(exited, "binary exit");
      if (bridge.listening) await new Promise((resolve) => bridge.close(resolve));
      return code;
    },
  };
}

async function fixture(key, options, fn) {
  const h = await start({
    component: fixtures[key].component,
    requestsPerInstance: key.startsWith("go/") ? 1000 : 0,
    ...options,
  });
  try {
    await fn({ ...h, logs: async () => h.logs });
  } finally {
    await h.stop();
  }
}

await runCases({ fixture, check });

await check("Readiness is reported once, before any request", async () => {
  const h = await start({ component: fixtures["counter/route.rs"].component });
  try {
    assert.deepEqual(
      h.messages.map((message) => message.type),
      ["server-started"],
    );
    assert.equal((await h.request()).text, "1");
  } finally {
    assert.equal(await h.stop(), 0);
  }
});

await check("Bridge headers never reach the guest", async () => {
  const h = await start({ component: fixtures["python/response/route.py"].component });
  try {
    const r = await h.request("/?case=request");
    const echoed = JSON.parse(r.text);
    assert.deepEqual(
      Object.keys(echoed.headers).filter((name) => name.startsWith("x-vercel-internal-")),
      [],
    );
    assert.equal(echoed.url, "https://function.example/?case=request");
  } finally {
    await h.stop();
  }
});

await check("A trap returns a plain 500 without its cause", async () => {
  const h = await start({ component: fixtures["counter/route.rs"].component });
  try {
    const r = await h.request("/panic");
    assert.equal(r.status, 500);
    assert.equal(r.text, "Internal Server Error");
    assert.match(h.logs, /polyroute couldn't serve the request/);
    assert.equal((await h.request()).text, "1");
  } finally {
    await h.stop();
  }
});

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
    const pending = h
      .request("/", {
        headers: { "x-upstream": `http://127.0.0.1:${stalled.address().port}/stall` },
      })
      .then(
        () => null,
        (error) => error,
      );
    await bounded(arrived.promise, "upstream arrival");
    await h.stop();
    await bounded(disconnected.promise, "upstream cancellation");
    await pending;
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});

await check("Invalid manifests fail before readiness", async () => {
  for (const manifest of [
    { component: path.join(output, "missing.cwasm") },
    { component: fixtures["counter/route.rs"].component, unexpected: true },
    { component: fixtures["counter/route.rs"].component, authority: "example.com" },
  ]) {
    await assert.rejects(start(manifest), /exited before readiness/);
  }
});

report.finished = new Date().toISOString();
await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: report.tests.length,
    skipped: report.skipped.length,
    failed: report.failures.length,
    requests: report.requests,
    endMessages: report.endMessages,
  }),
);
process.exitCode = report.failures.length > 0 ? 1 : 0;
