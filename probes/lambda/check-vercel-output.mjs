// Starts each native function in a Build Output directory the way Vercel does,
// with no arguments from its own directory, and requires the same response as
// its TypeScript twin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { bounded, deferred } from "./protocol.mjs";

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Provide --output, the Build Output directory to check.");
const functions = path.join(path.resolve(values.output), "functions/api");
const requests = [
  { name: "primes", target: "/api/primes?limit=10000", body: '{"limit":10000,"primes":1229}' },
  { name: "slug", target: "/api/slug?text=hello", body: '{"slug":"hello","text":"hello"}\n' },
  {
    name: "stats",
    target: "/api/stats",
    method: "POST",
    send: "[1, 2, 3, 4]",
    body: '{"count":4,"mean":2.5,"median":2.5}',
  },
];
const scratch = await mkdtemp(path.join(os.tmpdir(), "polyroute-vercel-output-"));
let failures = 0;

function send(port, { target, method = "GET", send = "" }) {
  return new Promise((resolve, reject) => {
    http
      .request(
        {
          host: "127.0.0.1",
          port,
          path: target,
          method,
          headers: {
            host: "function.example",
            "x-forwarded-proto": "https",
            "x-vercel-internal-invocation-id": "output-check",
            "x-vercel-internal-request-id": "1",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              type: res.headers["content-type"],
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      )
      .on("error", reject)
      .end(send);
  });
}

for (const request of requests) {
  const { name, target, method = "GET" } = request;
  try {
    const directory = path.join(functions, `${name}.func`);
    const config = JSON.parse(await readFile(path.join(directory, ".vc-config.json")));
    assert.equal(config.runtime, "executable");
    const socketPath = path.join(scratch, `${name}.sock`);
    const started = deferred();
    const ended = deferred();
    const bridge = net.createServer((socket) => {
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\0")) !== -1) {
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (message.type === "server-started") started.resolve(message.payload.httpPort);
          if (message.type === "end") ended.resolve(message.payload);
        }
      });
    });
    bridge.listen(socketPath);
    await once(bridge, "listening");
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const child = spawn(path.join(directory, config.handler), [], {
      cwd: directory,
      env: { VERCEL_IPC_PATH: socketPath, VERCEL_DEV_PORT: String(port) },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exited = once(child, "exit");
    try {
      assert.equal(await bounded(started.promise, `${name} readiness`), port);
      const native = await send(port, request);
      await bounded(ended.promise, `${name} end message`);
      const twin = await import(
        pathToFileURL(path.join(functions, `${name}-ts.func`, "index.mjs")).href
      );
      const init = method === "GET" ? {} : { method, body: request.send };
      const response = await twin[method](new Request(`https://function.example${target}`, init));
      const expected = Buffer.from(await response.arrayBuffer());
      assert.equal(native.status, response.status, `${name} status`);
      assert.equal(native.body.toString(), expected.toString(), `${name} body`);
      assert.equal(native.body.toString(), request.body, `${name} benchmark body`);
      console.log(`PASS ${name}: ${native.body.toString().trim()}`);
    } finally {
      child.kill("SIGTERM");
      const [code] = await bounded(exited, `${name} exit`);
      assert.equal(code, 0, `${name} exit code`);
      await new Promise((resolve) => bridge.close(resolve));
    }
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
process.exitCode = failures > 0 ? 1 : 0;
