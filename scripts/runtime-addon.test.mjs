import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { addonPath } from "../packages/polyroute-wasmtime/index.js";

test("the deployment addon exposes the runtime without a compiler", async () => {
  // A separate process releases the library mapping before Windows cleanup.
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import { createRequire } from "node:module";
     const addon = createRequire(import.meta.url)(process.argv[1]);
     console.log(JSON.stringify({
       info: addon.info(),
       route: typeof addon.Route,
       compiler: typeof addon.precompile,
     }));`,
    addonPath,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.route, "function");
  assert.match(result.info.target, /^[\w-]+$/);
  assert.match(result.info.wasmtime, /^\d+\.\d+\.\d+$/);
  assert.equal(result.compiler, "undefined");
});
