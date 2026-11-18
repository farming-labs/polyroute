import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { bounded, event } from "./protocol.mjs";
import { runCases } from "./cases.mjs";

if (process.platform !== "linux")
  throw new Error("The emulator probe requires Linux Docker host networking.");
const { values } = parseArgs({
  options: { packages: { type: "string" }, output: { type: "string" } },
});
if (!values.packages || !values.output)
  throw new Error("Provide --packages and a new --output directory.");
const packagesRoot = path.resolve(values.packages);
const output = path.resolve(values.output);
await mkdir(output);
const packages = JSON.parse(await readFile(path.join(packagesRoot, "packages.json")));
const image =
  "public.ecr.aws/lambda/provided@sha256:33df7155c46bef0c6768e2388c3c9ade2293662f46afdbdc5501ef91fafd2a81";
const exec = promisify(execFile);
const report = { image, tests: [], failures: [], invocations: 0 };
let sequence = 0;
async function docker(args) {
  return (await exec("docker", args, { maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout;
}
function request(method, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 8080,
        path: method === "GET" ? "/" : "/2015-03-31/functions/function/invocations",
        method,
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Emulator request timed out.")));
    req.end(body);
  });
}
async function waitUntilListening() {
  const deadline = performance.now() + 15000;
  while (true) {
    try {
      const response = await request("GET");
      assert.equal(response.status, 404, "Unexpected service on the emulator port.");
      return;
    } catch (error) {
      if (error.code !== "ECONNREFUSED" || performance.now() >= deadline) throw error;
      await setImmediate();
    }
  }
}
async function fixture(route, options, fn) {
  const item = packages.find(
    (entry) =>
      entry.route === route &&
      entry.perRequest === Boolean(options.perRequest) &&
      JSON.stringify(entry.outboundAllow) === JSON.stringify(options.outboundAllow ?? []),
  );
  assert.ok(item, `Missing package for ${route}: ${JSON.stringify(options)}`);
  const directory = path.join(packagesRoot, item.directory);
  const portCheck = net.createServer();
  portCheck.listen(8080, "127.0.0.1");
  await once(portCheck, "listening");
  await new Promise((resolve, reject) =>
    portCheck.close((error) => (error ? reject(error) : resolve())),
  );
  const id = (
    await docker([
      "run",
      "--detach",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${directory},dst=/var/task,readonly`,
      "--env",
      "AWS_LAMBDA_FUNCTION_NAME=local-probe",
      "--env",
      "AWS_LAMBDA_FUNCTION_MEMORY_SIZE=128",
      "--env",
      "AWS_LAMBDA_FUNCTION_VERSION=$LATEST",
      "--entrypoint",
      "/usr/local/bin/aws-lambda-rie",
      image,
      "/var/task/bootstrap",
    ])
  ).trim();
  const index = ++sequence;
  try {
    await bounded(waitUntilListening(), "emulator readiness");
    const host = {
      async logs() {
        const result = await exec("docker", ["logs", id], {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15000,
        });
        return result.stdout + result.stderr;
      },
      async invoke(input) {
        const response = await request("POST", JSON.stringify(input));
        report.invocations++;
        const value = JSON.parse(response.body);
        if (
          response.headers["lambda-runtime-function-error-type"] ||
          response.headers["x-amz-function-error"] ||
          value.errorType
        )
          return { kind: "error", value };
        assert.equal(response.status, 200, response.body);
        return { kind: "response", value };
      },
      async request(uri, options) {
        const result = await this.invoke(event(uri, options));
        if (result.kind === "error") return { status: 500, error: result.value };
        const value = result.value;
        assert.equal(typeof value.statusCode, "number");
        const bytes = Buffer.from(value.body ?? "", value.isBase64Encoded ? "base64" : "utf8");
        return {
          status: value.statusCode,
          bytes,
          text: bytes.toString(),
          headers: value.headers,
          cookies: value.cookies,
        };
      },
    };
    await fn(host);
  } finally {
    try {
      const logs = await exec("docker", ["logs", id], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000,
      });
      await writeFile(path.join(output, `${index}-${item.name}.log`), logs.stdout + logs.stderr);
    } finally {
      await docker(["rm", "--force", id]);
    }
  }
}
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
await runCases({ fixture, check });
await writeFile(path.join(output, "rie-results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: report.tests.length,
    failed: report.failures.length,
    invocations: report.invocations,
  }),
);
if (report.failures.length) process.exitCode = 1;
