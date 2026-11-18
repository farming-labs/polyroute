import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOutboundPolicy } from "./outbound.js";
import { createNativeOutbound, type NativeOutboundRequest } from "./wasmtime-outbound.js";

let server: http.Server;
let base: URL;
const received: string[] = [];

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(request.url!);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${base.href.replace("127.0.0.1", "localhost")}denied` });
      response.end();
    } else if (request.url === "/gzip") {
      const body = gzipSync("decoded");
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": body.length,
        "set-cookie": ["a=1", "b=2"],
      });
      response.end(body);
    } else if (request.url === "/stall") {
      response.writeHead(200);
      response.write("pending");
    } else {
      response.writeHead(201, { "x-echo": request.headers["x-sent"] ?? "" });
      response.end(Buffer.concat(chunks));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  server.closeAllConnections();
  const closed = once(server, "close");
  server.close();
  await closed;
});

function request(path: string, init: Partial<NativeOutboundRequest> = {}): NativeOutboundRequest {
  return {
    method: "GET",
    url: new URL(path, base).href,
    headers: [],
    body: Buffer.alloc(0),
    ...init,
  };
}

function callback(signal = new AbortController().signal, allow = [base.host]) {
  return createNativeOutbound(createOutboundPolicy({ allow }), signal);
}

describe("native outbound wire format", () => {
  it("preserves binary request bodies and Latin-1 headers across real HTTP", async () => {
    const body = Buffer.from([0, 128, 255]);
    const response = await callback()(
      request("/echo", {
        method: "POST",
        body,
        headers: ["x-sent", "caf\u00e9"],
      }),
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(response.body).toEqual(body);
    expect(response.headers).toContain("caf\u00e9");
  });

  it("enforces hosts and explicit ports before making a request", async () => {
    const before = received.length;
    expect(
      (await callback()(request("/", { url: base.href.replace("127.0.0.1", "localhost") }))).error,
    ).toBe("HTTP-request-denied");
    expect((await callback(undefined, ["127.0.0.1:1"])(request("/"))).error).toBe(
      "HTTP-request-denied",
    );
    expect((await callback(undefined, ["*.example.com"])(request("/"))).error).toBe(
      "HTTP-request-denied",
    );
    expect(received.length).toBe(before);
  });

  it("returns invalid URI and method codes in the native response", async () => {
    expect((await callback()(request("/", { url: "file:///etc/passwd" }))).error).toBe(
      "HTTP-request-URI-invalid",
    );
    expect((await callback()(request("/", { url: "invalid" }))).error).toBe(
      "HTTP-request-URI-invalid",
    );
    expect((await callback()(request("/", { body: Buffer.from("GET body") }))).error).toBe(
      "HTTP-request-method-invalid",
    );
  });

  it("retains redirects without calling their denied destination", async () => {
    const before = received.length;
    const response = await callback()(request("/redirect"));
    expect(response.status).toBe(302);
    expect(received.slice(before)).toEqual(["/redirect"]);
  });

  it("keeps duplicate cookies and strips headers for a decoded body", async () => {
    const response = await callback()(request("/gzip"));
    expect(response.body.toString()).toBe("decoded");
    expect(response.headers).not.toContain("content-encoding");
    expect(response.headers).not.toContain("content-length");
    const cookies = response.headers.flatMap((value, index) =>
      index % 2 === 0 && value === "set-cookie" ? [response.headers[index + 1]] : [],
    );
    expect(cookies).toEqual(["a=1", "b=2"]);
  });

  it("passes nanosecond timeout options to the shared host", async () => {
    const response = await callback()(request("/stall", { betweenBytesTimeoutNs: "1000000" }));
    expect(response.error).toBe("connection-read-timeout");
  });

  it("aborts pending upstream work through its request's controller", async () => {
    const controller = new AbortController();
    const started = once(server, "request");
    const pending = callback(controller.signal)(request("/stall"));
    await started;
    controller.abort(new Error("request finished"));
    expect((await pending).error).toBe("internal-error");
  });
});
