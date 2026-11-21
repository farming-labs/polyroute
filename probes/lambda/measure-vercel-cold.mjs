// Measures first requests on Vercel against a Build Output from
// `build-vercel-output.mjs`. Each round deploys a fresh preview, warms the
// deployment with a request no function serves and lets it settle, then sends
// one first request to every function in an order rotated each round, and
// finally warm requests that give each deployment's baseline. `--revisit` instead sends one more
// request to every function of earlier deployments, after they have been idle
// long enough for Vercel to stop their instances.
//
// Native functions built with `serverTiming` report their startup phases on
// their first response. `wait`, the time from readiness to that request,
// separates instances Vercel started ahead of the request (seconds) from ones
// it started for the request (milliseconds).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    deploy: { type: "string" },
    scope: { type: "string" },
    functions: { type: "string" },
    rounds: { type: "string", default: "8" },
    warm: { type: "string", default: "3" },
    "settle-ms": { type: "string", default: "30000" },
    revisit: { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["deploy", "scope", "output"]) {
  if (!values[key])
    throw new Error(
      `Provide --${key}. --deploy is the linked directory holding .vercel/output, --output a new directory.`,
    );
}
const deployDir = path.resolve(values.deploy);
const output = path.resolve(values.output);
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
await mkdir(output);
const samplesFile = path.join(output, "samples.ndjson");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: deployDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let sequence = 0;
async function request(deployment, fn, status = 200) {
  const index = ++sequence;
  const body = path.join(output, `body-${index}`);
  const headers = path.join(output, `headers-${index}`);
  const curl = ["-s", "-o", body, "-D", headers, "-w", "%{json}"];
  if (fn.method) curl.push("--request", fn.method, "--data", fn.send);
  const args = [
    "curl",
    fn.path,
    "--deployment",
    deployment,
    "--scope",
    values.scope,
    "--",
    ...curl,
  ];
  let result = await run("vercel", args);
  // curl exits 6, 7 or 35 when name resolution, the TCP connection or the TLS
  // handshake failed: no HTTP request reached the function, so retrying can't
  // hide a function failure or warm a function early.
  let retries = 0;
  while ([6, 7, 35].includes(result.code) && retries < 3) {
    retries++;
    result = await run("vercel", args);
  }
  assert.equal(result.code, 0, `vercel curl failed for ${fn.path}:\n${result.stderr}`);
  const timing = JSON.parse(result.stdout);
  const text = await readFile(body, "utf8").catch(() => "");
  const head = await readFile(headers, "utf8");
  assert.equal(timing.http_code, status, `${fn.path} returned ${timing.http_code}: ${text}`);
  if (fn.body !== undefined) assert.equal(text, fn.body, `${fn.path} returned an unexpected body`);
  return {
    // From TLS completion to the first response byte: one round trip plus
    // the provider's routing and the function's work, including any start.
    afterTlsMs: (timing.time_starttransfer - timing.time_appconnect) * 1000,
    totalMs: timing.time_total * 1000,
    vercelId: /^x-vercel-id:\s*(.+)$/im.exec(head)?.[1]?.trim(),
    serverTiming: /^server-timing:\s*(.+)$/im.exec(head)?.[1]?.trim(),
    retries,
  };
}

async function record(sample) {
  await appendFile(samplesFile, JSON.stringify(sample) + "\n");
}

if (values.revisit) {
  const deployments = JSON.parse(await readFile(values.revisit, "utf8"));
  for (const [round, { id }] of deployments.entries()) {
    const shift = round % functions.length;
    const order = [...functions.slice(shift), ...functions.slice(0, shift)];
    for (const [position, fn] of order.entries()) {
      const r = await request(id, fn);
      await record({ round, deployment: id, phase: "revisit", position, name: fn.name, ...r });
    }
    console.log(`revisited ${round + 1}/${deployments.length}: ${id}`);
  }
  process.exit(0);
}

// Refuse to deploy a Build Output that differs from its recorded file list: a
// missing component would deploy and then fail every native request.
{
  const root = path.join(deployDir, ".vercel/output");
  const recorded = JSON.parse(
    await readFile(path.join(deployDir, ".vercel/output.files.json"), "utf8"),
  );
  const actual = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(actual, recorded.files.map((file) => file.file).sort(), "Build Output changed");
  for (const file of recorded.files) {
    const bytes = await readFile(path.join(root, file.file));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, file.sha256, `${file.file} changed`);
  }
}

const deployments = [];
const rounds = Number(values.rounds);
const warm = Number(values.warm);
for (let round = 0; round < rounds; round++) {
  const deploy = ["deploy", "--prebuilt", "--yes", "--scope", values.scope];
  let deployed = await run("vercel", deploy);
  for (let attempt = 1; deployed.code !== 0 && attempt < 3; attempt++) {
    console.log(`Deploy failed; retrying. ${deployed.stderr.trim().split("\n").at(-1)}`);
    deployed = await run("vercel", deploy);
  }
  assert.equal(deployed.code, 0, `vercel deploy failed:\n${deployed.stderr}`);
  const url = deployed.stdout.trim().split("\n").at(-1);
  // `vercel deploy` prints an "Inspect:" link whose last segment is the id.
  const id = /Inspect:\s*https:\/\/vercel\.com\/\S+\/(\w+)/.exec(deployed.stderr)?.[1];
  assert.ok(id, `couldn't read the deployment id for ${url}:\n${deployed.stderr}`);
  deployments.push({ round, url, id, createdAt: new Date().toISOString() });
  await writeFile(
    path.join(output, "deployments.json"),
    JSON.stringify(deployments, null, 2) + "\n",
  );
  console.log(`round ${round + 1}/${rounds}: ${id}`);
  // A new deployment's first request pays for routing setup, whichever path
  // it asks for. A path no function serves takes that cost off the functions.
  const first = await request(id, { path: "/__polyroute-warmup" }, 404);
  await record({ round, deployment: id, phase: "deployment-first", name: "warmup", ...first });
  // For about 15 seconds after a deploy, most first requests take an extra
  // ~100 ms whatever the runtime: in earlier runs, 38 of 46 requests in the
  // first four positions did, against 2 of 76 from the ninth on. Waiting keeps
  // that out of the comparison. Vercel had already started the instances, so
  // the wait doesn't change what the first request meets.
  await new Promise((resolve) => setTimeout(resolve, Number(values["settle-ms"])));
  const shift = round % functions.length;
  const order = [...functions.slice(shift), ...functions.slice(0, shift)];
  for (const [position, fn] of order.entries()) {
    const r = await request(id, fn);
    await record({ round, deployment: id, phase: "first", position, name: fn.name, ...r });
  }
  for (let i = 0; i < warm; i++) {
    for (const fn of i % 2 === 0 ? order : [...order].reverse()) {
      const r = await request(id, fn);
      await record({ round, deployment: id, phase: "warm", index: i, name: fn.name, ...r });
    }
  }
}
console.log(`Wrote ${rounds} rounds to ${samplesFile}.`);
