import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Owns loaded native libraries until close() waits for the process to exit. */
export function createRouteProcess() {
  const child = fork(fileURLToPath(new URL("./route-process-child.mjs", import.meta.url)), [], {
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let nextId = 0;
  const pending = new Map();
  let closed = false;
  const fail = (error) => {
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("message", ({ id, value, error }) => {
    const call = pending.get(id);
    if (call === undefined) return;
    pending.delete(id);
    if (error === undefined) call.resolve(value);
    else call.reject(Object.assign(new Error(error.message), error));
  });
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      fail(new Error(`Route process exited (${signal ?? code}).`));
      resolve();
    });
  });
  const call = (input) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("The route process is closed."));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.send({ id, ...input }, (error) => {
        if (error) fail(error);
      });
    });
  return {
    async load(file) {
      const url = pathToFileURL(file).href;
      const exports = await call({ type: "load", url });
      return Object.fromEntries(
        exports.map(([name, route]) => [
          name,
          {
            route,
            async fetch(request) {
              const result = await call({
                type: "fetch",
                url,
                name,
                request: {
                  url: request.url,
                  method: request.method,
                  headers: [...request.headers],
                  body: request.body === null ? null : Buffer.from(await request.arrayBuffer()),
                },
              });
              return new Response(result.body, { status: result.status, headers: result.headers });
            },
          },
        ]),
      );
    },
    async close() {
      closed = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await exited;
    },
  };
}
