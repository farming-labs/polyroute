import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Fields,
  FutureIncomingResponse,
  OutgoingBody,
  OutgoingRequest,
  OutgoingResponse,
  ResponseOutparam,
  createImports,
  createLineSink,
  type OutboundContext,
} from "./host.js";
import { createWasiHttpHandler } from "./index.js";
import { createOutboundPolicy, sendOutbound, type OutboundRequest } from "./outbound.js";

const text = (value: Uint8Array) => new TextDecoder().decode(value);
const bytes = (value: string) => new TextEncoder().encode(value);

let server: http.Server;
let base: URL;
const stalled = new Set<http.ServerResponse>();

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url ?? "/", "http://upstream");
    switch (url.pathname) {
      case "/gzip": {
        const encoded = gzipSync("decoded by fetch");
        response.writeHead(200, { "content-encoding": "gzip", "content-length": encoded.length });
        response.end(encoded);
        return;
      }
      case "/custom-encoding":
        response.writeHead(200, { "content-encoding": "custom" });
        response.end("raw bytes");
        return;
      case "/cookies":
        response.writeHead(200, { "set-cookie": ["a=1", "b=2"] });
        response.end();
        return;
      case "/redirect":
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      case "/no-headers":
        stalled.add(response);
        return;
      case "/stall-body":
        response.writeHead(200);
        response.write("first ");
        stalled.add(response);
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(
          `${request.method} ${request.url} accept-encoding=${request.headers["accept-encoding"]} body=${body}`,
        );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(() => {
  for (const response of stalled) response.destroy();
  server.close();
});

function request(pathname: string, init: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    method: "GET",
    url: new URL(pathname, base),
    headers: [],
    body: undefined,
    connectTimeout: undefined,
    firstByteTimeout: undefined,
    betweenBytesTimeout: undefined,
    ...init,
  };
}

describe("createOutboundPolicy", () => {
  const allows = (allow: string[], url: string) =>
    createOutboundPolicy({ allow }).allows(new URL(url));

  it("matches a hostname on any port, and a hostname with a port on that port only", () => {
    expect(allows(["api.example.com"], "https://api.example.com/v1")).toBe(true);
    expect(allows(["api.example.com"], "http://API.example.com:8080/")).toBe(true);
    expect(allows(["api.example.com"], "https://example.com/")).toBe(false);
    expect(allows(["localhost:8787"], "http://localhost:8787/")).toBe(true);
    expect(allows(["localhost:8787"], "http://localhost:8788/")).toBe(false);
    expect(allows(["example.com:443"], "https://example.com/")).toBe(true);
    expect(allows(["example.com:80"], "https://example.com/")).toBe(false);
    expect(allows(["[::1]:8080"], "http://[::1]:8080/")).toBe(true);
  });

  it("matches subdomains for `*.` but not the domain itself, and anything for `*`", () => {
    expect(allows(["*.example.com"], "https://api.example.com/")).toBe(true);
    expect(allows(["*.example.com"], "https://a.b.example.com/")).toBe(true);
    expect(allows(["*.example.com"], "https://example.com/")).toBe(false);
    expect(allows(["*.example.com"], "https://badexample.com/")).toBe(false);
    expect(allows(["*"], "https://anything.test/")).toBe(true);
    expect(allows([], "https://anything.test/")).toBe(false);
  });

  it("rejects an `allow` that isn't a list", () => {
    expect(() => createOutboundPolicy({ allow: "example.com" as never })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message:
          '`outbound.allow` must be a list of hosts, such as `api.example.com`, `localhost:8787`, `*.example.com`, or `*`, but it\'s "example.com".',
      }),
    );
  });
});

describe("sendOutbound", () => {
  it("drops `content-encoding` and `content-length` for a body fetch decoded", async () => {
    const result = await sendOutbound(
      request("/gzip", { headers: [["accept-encoding", "gzip"]] }),
      undefined,
    );
    expect(result.tag).toBe("ok");
    if (result.tag !== "ok") return;
    expect(text(result.val.body)).toBe("decoded by fetch");
    const names = result.val.headers.map(([name]) => name);
    expect(names).not.toContain("content-encoding");
    expect(names).not.toContain("content-length");
  });

  it("keeps an encoding fetch doesn't decode, with the body as it arrived", async () => {
    const result = await sendOutbound(request("/custom-encoding"), undefined);
    if (result.tag !== "ok") throw new Error(`Expected a response, got ${result.val.tag}.`);
    expect(text(result.val.body)).toBe("raw bytes");
    expect(result.val.headers).toContainEqual(["content-encoding", "custom"]);
  });

  it("asks for an uncompressed response unless the route set `accept-encoding`", async () => {
    const plain = await sendOutbound(request("/echo"), undefined);
    const own = await sendOutbound(
      request("/echo", { headers: [["accept-encoding", "br"]] }),
      undefined,
    );
    expect(plain.tag === "ok" && text(plain.val.body)).toBe(
      "GET /echo accept-encoding=identity body=",
    );
    expect(own.tag === "ok" && text(own.val.body)).toBe("GET /echo accept-encoding=br body=");
  });

  it("sends a body, but refuses one with GET, which fetch can't send", async () => {
    const posted = await sendOutbound(
      request("/echo", { method: "POST", body: bytes("ping") }),
      undefined,
    );
    expect(posted.tag === "ok" && text(posted.val.body)).toBe(
      "POST /echo accept-encoding=identity body=ping",
    );
    expect(await sendOutbound(request("/echo", { body: bytes("ping") }), undefined)).toEqual({
      tag: "err",
      val: { tag: "HTTP-request-method-invalid" },
    });
  });

  it("keeps each `set-cookie` separate and doesn't follow redirects", async () => {
    const cookies = await sendOutbound(request("/cookies"), undefined);
    expect(
      cookies.tag === "ok" && cookies.val.headers.filter(([name]) => name === "set-cookie"),
    ).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    const redirect = await sendOutbound(request("/redirect"), undefined);
    expect(redirect.tag === "ok" && redirect.val.status).toBe(302);
    expect(redirect.tag === "ok" && redirect.val.headers).toContainEqual([
      "location",
      "/elsewhere",
    ]);
  });

  it("maps a refused connection to `connection-refused`", async () => {
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const { port } = closed.address() as AddressInfo;
    closed.close();
    await once(closed, "close");
    const result = await sendOutbound(
      { ...request("/"), url: new URL(`http://127.0.0.1:${port}/`) },
      undefined,
    );
    expect(result).toEqual({ tag: "err", val: { tag: "connection-refused" } });
  });

  it("enforces the first-byte and between-bytes timeouts", async () => {
    expect(
      await sendOutbound(request("/no-headers", { firstByteTimeout: 50_000_000n }), undefined),
    ).toEqual({ tag: "err", val: { tag: "connection-read-timeout" } });
    expect(
      await sendOutbound(request("/stall-body", { betweenBytesTimeout: 50_000_000n }), undefined),
    ).toEqual({ tag: "err", val: { tag: "connection-read-timeout" } });
  });

  it("resolves with an error instead of rejecting when its signal aborts", async () => {
    const controller = new AbortController();
    const pending = sendOutbound(request("/no-headers"), controller.signal);
    controller.abort();
    expect((await pending).tag).toBe("err");
  });
});

describe("wasi:http/outgoing-handler", () => {
  type Handle = (request: OutgoingRequest, options: undefined) => FutureIncomingResponse;

  function handler(allow: string[] | undefined): Handle {
    const sink = createLineSink(() => {});
    const outbound: OutboundContext | undefined =
      allow === undefined
        ? undefined
        : { policy: createOutboundPolicy({ allow }), signal: undefined };
    const imports = createImports({ stdout: sink, stderr: sink, outbound });
    return imports["wasi:http/outgoing-handler"].handle as Handle;
  }

  function outgoing(authority: string | undefined, pathWithQuery = "/echo"): OutgoingRequest {
    const request = new OutgoingRequest(new Fields());
    request.setScheme({ tag: "HTTP" });
    request.setAuthority(authority);
    request.setPathWithQuery(pathWithQuery);
    return request;
  }

  async function settle(future: FutureIncomingResponse) {
    await future.subscribe().block();
    return future.get();
  }

  it("answers a denied host through the future, already settled", () => {
    const future = handler(["example.com"])(outgoing(base.host), undefined);
    expect(future.subscribe().ready()).toBe(true);
    expect(future.get()).toEqual({
      tag: "ok",
      val: { tag: "err", val: { tag: "HTTP-request-denied" } },
    });
    expect(future.get()).toEqual({ tag: "err", val: undefined });
  });

  it("denies every request in a route that wasn't given `outbound`", () => {
    const future = handler(undefined)(outgoing(base.host), undefined);
    expect(future.get()).toEqual({
      tag: "ok",
      val: { tag: "err", val: { tag: "HTTP-request-denied" } },
    });
  });

  it("rejects a request without an authority or with a relative path", () => {
    const handle = handler(["*"]);
    for (const request of [outgoing(undefined), outgoing(base.host, "echo")]) {
      expect(handle(request, undefined).get()).toEqual({
        tag: "ok",
        val: { tag: "err", val: { tag: "HTTP-request-URI-invalid" } },
      });
    }
  });

  it("sends the body the guest writes after `handle`, once it's finished", async () => {
    const request = outgoing(base.host);
    request.setMethod({ tag: "post" });
    const body = request.body();
    const future = handler([base.hostname])(request, undefined);
    expect(future.subscribe().ready()).toBe(false);
    body.write().blockingWriteAndFlush(bytes("written late"));
    OutgoingBody.finish(body, undefined);
    const result = await settle(future);
    if (result?.tag !== "ok" || result.val.tag !== "ok") throw new Error("Expected a response.");
    const response = result.val.val;
    expect(response.status()).toBe(200);
    expect(text(response.headers().get("content-type")[0]!)).toBe("text/plain");
    const stream = response.consume().stream();
    expect(text(stream.read(1024n))).toBe("POST /echo accept-encoding=identity body=written late");
  });

  it("fails the request when the guest drops its body unfinished", async () => {
    const request = outgoing(base.host);
    request.setMethod({ tag: "post" });
    const body = request.body();
    const future = handler([base.hostname])(request, undefined);
    body[Symbol.dispose]();
    expect(await settle(future)).toEqual({
      tag: "ok",
      val: {
        tag: "err",
        val: {
          tag: "internal-error",
          val: "The route dropped the request body without finishing it.",
        },
      },
    });
  });
});

describe("a route that sends requests", () => {
  it("cancels the requests it's still waiting on once it has answered", async () => {
    let future: FutureIncomingResponse | undefined;
    const route = createWasiHttpHandler({
      route: "route.rs",
      coreModules: {},
      outbound: { allow: [base.hostname] },
      instantiate: (_getCoreModule, imports) => ({
        incomingHandler: {
          handle(_request, responseOut) {
            const outgoing = new OutgoingRequest(new Fields());
            outgoing.setScheme({ tag: "HTTP" });
            outgoing.setAuthority(base.host);
            outgoing.setPathWithQuery("/no-headers");
            const handle = imports["wasi:http/outgoing-handler"].handle as (
              request: OutgoingRequest,
              options: undefined,
            ) => FutureIncomingResponse;
            future = handle(outgoing, undefined);
            ResponseOutparam.set(responseOut, {
              tag: "ok",
              val: new OutgoingResponse(new Fields()),
            });
            return undefined;
          },
        },
      }),
    });
    expect((await route.fetch(new Request("http://localhost/"))).status).toBe(200);
    await future!.subscribe().block();
    expect(future!.get()).toEqual({
      tag: "ok",
      val: { tag: "err", val: { tag: "internal-error", val: "The route answered its request." } },
    });
  });

  it("fails on a runtime without JSPI, naming the runtime it needs", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Suspending");
    if (descriptor !== undefined) delete (WebAssembly as { Suspending?: unknown }).Suspending;
    try {
      const route = createWasiHttpHandler({
        route: "route.rs",
        instantiate: () => Promise.reject(new Error("The runtime check should run first.")),
        coreModules: {},
        outbound: { allow: ["*"] },
      });
      await expect(route.fetch(new Request("http://localhost/"))).rejects.toMatchObject({
        code: "UNSUPPORTED_RUNTIME",
        message:
          "Route `route.rs` sends HTTP requests, which needs WebAssembly JavaScript Promise Integration (`WebAssembly.Suspending`). This JavaScript runtime doesn't have it. Run the server on Node 24 or later.",
      });
    } finally {
      if (descriptor !== undefined) Object.defineProperty(WebAssembly, "Suspending", descriptor);
    }
  });
});
