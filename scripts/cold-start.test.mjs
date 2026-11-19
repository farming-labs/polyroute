import assert from "node:assert/strict";
import { test } from "node:test";
import { measureColdStart } from "./cold-start.mjs";

test("cold start ends at the verified response and excludes shutdown", async () => {
  let time = 0;
  let stopped = false;
  const child = {};
  const result = await measureColdStart({
    now: () => time,
    start: () => {
      time += 10;
      return { child, origin: Promise.resolve("http://localhost") };
    },
    request: async (origin) => {
      assert.equal(origin, "http://localhost");
      time += 5;
      return true;
    },
    stop: async (process) => {
      assert.equal(process, child);
      time += 100;
      stopped = true;
    },
  });
  assert.deepEqual(result, { ok: true, ms: 15 });
  assert.equal(stopped, true);
});

for (const failure of ["startup", "request"]) {
  test(`stops the process after a ${failure} failure`, async () => {
    const error = new Error(failure);
    let stopped = false;
    await assert.rejects(
      measureColdStart({
        start: () => ({
          child: {},
          origin: failure === "startup" ? Promise.reject(error) : Promise.resolve("origin"),
        }),
        request: async () => {
          throw error;
        },
        stop: async () => {
          stopped = true;
        },
      }),
      error,
    );
    assert.equal(stopped, true);
  });
}

test("a wrong response is reported and the process is still stopped", async () => {
  let stopped = false;
  const result = await measureColdStart({
    start: () => ({ child: {}, origin: Promise.resolve("origin") }),
    request: async () => false,
    stop: async () => {
      stopped = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(stopped, true);
});
