import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WasiHttpRoute } from "../src/runtime/index.js";
import { buildServerEntry, fixturesDir } from "./helpers.js";
import { createRouteProcess } from "./route-process.mjs";

const jspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";
const languages = ["rust", "go", "python"] as const;

interface OutboundEntry {
  rust: WasiHttpRoute;
  go: WasiHttpRoute;
  python: WasiHttpRoute;
}

describe.each(["jco", "wasmtime"] as const)("%s outbound runtime", (runtime) => {
  const canSend = runtime === "wasmtime" || jspi;
  const server = runtime === "wasmtime" ? createRouteProcess() : undefined;
  let outDir: string;
  let code: string;
  let routes: OutboundEntry;
  let upstream: http.Server;
  let base: string;
  const received: string[] = [];
  let gathering: Array<() => void> = [];

  beforeAll(async () => {
    upstream = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push(`${request.method} ${request.url}`);
      const url = new URL(request.url ?? "/", "http://upstream");
      if (url.pathname === "/gather") {
        // Answers only once `n` requests are waiting here, so a test that sends
        // `n` at once finishes only if they're in flight at the same time.
        const n = Number(url.searchParams.get("n"));
        await new Promise<void>((resolve) => {
          gathering.push(resolve);
          if (gathering.length < n) return;
          for (const release of gathering) release();
          gathering = [];
        });
      }
      response.writeHead(201, { "content-type": "text/plain" });
      response.end(
        `${request.method} ${request.url} x-sent-by=${request.headers["x-sent-by"]} body=${body}`,
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    outDir = await mkdtemp(path.join(tmpdir(), "polyroute-outbound-"));
    const built = await buildServerEntry(
      "outbound-entry.ts",
      path.join(outDir, "server"),
      fixturesDir,
      {
        outbound: { allow: ["127.0.0.1"] },
        experimental: { runtime },
      },
    );
    code = built.code;
    routes = (await (server === undefined
      ? import(pathToFileURL(built.file).href)
      : server.load(built.file))) as OutboundEntry;
  });

  afterAll(async () => {
    await server?.close();
    upstream?.closeAllConnections();
    if (upstream?.listening) {
      const closed = once(upstream, "close");
      upstream.close();
      await closed;
    }
    if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
  });

  describe.runIf(runtime === "jco")("production build of routes that send requests", () => {
    it("calls every host import that can't suspend without jco's async task bookkeeping", () => {
      const trampolines = code.match(/\b_trampoline\d+\.fnName = "/g) ?? [];
      const suspending = code.match(/\b_trampoline\d+\.manuallyAsync = !0;/g) ?? [];
      const direct =
        code.match(/\$checkMayLeave(?:\$\d+)?\(_jcoTaskCompatImportContext\.mayLeave, \d+\);/g) ??
        [];
      // `poll` and `pollable.block` in each route. The Python route lowers `poll`
      // for two of its core modules, so it has three.
      expect(suspending.length).toBe(7);
      expect(direct.length).toBe(trampolines.length - suspending.length);
    });
  });

  describe.runIf(canSend).each(languages)("%s route that sends requests", (language) => {
    const call = (headers: Record<string, string>, init: RequestInit = {}) =>
      routes[language].fetch(new Request("http://localhost/", { ...init, headers }));

    it("sends a GET with the language's own client and answers with the response", async () => {
      const response = await call({ "x-upstream": `${base}/echo?name=farm` });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-upstream-status")).toBe("201");
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(await response.text()).toBe(`GET /echo?name=farm x-sent-by=${language} body=`);
    });

    it("sends the request body", async () => {
      const response = await call(
        { "x-upstream": `${base}/echo` },
        { method: "POST", body: "hello upstream" },
      );
      expect(await response.text()).toBe(`POST /echo x-sent-by=${language} body=hello upstream`);
    });

    it("denies a host that isn't allowed with an error the route handles", async () => {
      const before = received.length;
      // `localhost` reaches the same server, but only `127.0.0.1` is allowed.
      const response = await call({
        "x-upstream": `${base.replace("127.0.0.1", "localhost")}/echo`,
      });
      expect(response.status).toBe(502);
      // Go's wasihttp prints the error code's case number: 15 is `HTTP-request-denied`.
      expect(await response.text()).toMatch(
        {
          rust: /HttpRequestDenied/,
          go: /incoming-response: \{15 <nil>\}/,
          python: /^ErrorCode_HttpRequestDenied\(\)$/,
        }[language],
      );
      expect(received.length).toBe(before);
    });

    it("serves concurrent requests while they wait, leaving the event loop free", async () => {
      // The upstream runs in this process and answers only once all three
      // requests reach it, so this passes only if each waits without blocking
      // the thread and without queueing behind the others.
      const responses = await Promise.all(
        [1, 2, 3].map(() => call({ "x-upstream": `${base}/gather?n=3` })),
      );
      for (const response of responses) {
        expect(await response.text()).toBe(`GET /gather?n=3 x-sent-by=${language} body=`);
      }
    });
  });

  describe.runIf(canSend)("python route that sends requests", () => {
    it("sends several at once from one handler with asyncio.gather", async () => {
      // The upstream answers only once all three are waiting, so they can't be
      // sent one after another.
      const response = await routes.python.fetch(
        new Request("http://localhost/", {
          headers: { "x-upstream": `${base}/gather?n=3`, "x-fan-out": "3" },
        }),
      );
      expect(await response.text()).toBe(
        Array.from({ length: 3 }, () => "GET /gather?n=3 x-sent-by=python body=").join("\n"),
      );
    });
  });

  describe.runIf(canSend)("timers in a route that sends requests", () => {
    it("suspend the route instead of blocking the event loop", async () => {
      let ticks = 0;
      const interval = setInterval(() => ticks++, 10);
      try {
        const response = await routes.rust.fetch(
          new Request("http://localhost/", {
            headers: { "x-upstream": `${base}/echo`, "x-sleep-ms": "300" },
          }),
        );
        expect(response.headers.get("x-upstream-status")).toBe("201");
      } finally {
        clearInterval(interval);
      }
      // A sleep that blocked the thread would leave the interval no chance to run.
      expect(ticks).toBeGreaterThanOrEqual(5);
    });
  });

  describe.skipIf(canSend)("a runtime without JSPI", () => {
    it("fails a route that sends requests, naming the runtime it needs", async () => {
      await expect(routes.rust.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
        code: "UNSUPPORTED_RUNTIME",
        message: expect.stringContaining("Run the server on Node 24 or later."),
      });
    });
  });
});
