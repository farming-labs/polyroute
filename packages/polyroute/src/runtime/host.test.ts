import { describe, expect, it } from "vitest";
import { SUPPORTED_INTERFACES } from "../interfaces.js";
import {
  Fields,
  IncomingRequest,
  InputStream,
  OutgoingBody,
  OutgoingResponse,
  createImports,
  createLineSink,
  readOutgoingResponse,
} from "./host.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw.");
}

describe("createImports", () => {
  it("provides exactly the interfaces the build allows", () => {
    const sink = createLineSink(() => {});
    expect(Object.keys(createImports({ stdout: sink, stderr: sink })).sort()).toEqual(
      [...SUPPORTED_INTERFACES].sort(),
    );
  });

  it("links the filesystem and sockets with nothing behind them", () => {
    const sink = createLineSink(() => {});
    const imports = createImports({ stdout: sink, stderr: sink }) as Record<
      string,
      Record<string, (...args: unknown[]) => unknown>
    >;
    expect(imports["wasi:filesystem/preopens"]!.getDirectories!()).toEqual([]);
    expect(thrown(() => imports["wasi:sockets/tcp-create-socket"]!.createTcpSocket!("ipv4"))).toBe(
      "access-denied",
    );
    expect(thrown(() => imports["wasi:sockets/udp-create-socket"]!.createUdpSocket!("ipv4"))).toBe(
      "access-denied",
    );
    expect(
      thrown(() => imports["wasi:sockets/ip-name-lookup"]!.resolveAddresses!(null, "example.com")),
    ).toBe("access-denied");
  });
});

describe("Fields", () => {
  it("matches names case-insensitively and lowercases them", () => {
    const fields = Fields.fromList([["Content-Type", bytes("text/plain")]]);
    expect(fields.has("content-type")).toBe(true);
    expect(fields.get("CONTENT-TYPE").map(text)).toEqual(["text/plain"]);
    expect(fields.entries().map(([name]) => name)).toEqual(["content-type"]);
  });

  it("rejects invalid names and values with invalid-syntax", () => {
    expect(thrown(() => Fields.fromList([["bad name", bytes("x")]]))).toEqual({
      tag: "invalid-syntax",
    });
    expect(thrown(() => new Fields().append("x-ok", bytes("a\r\nb")))).toEqual({
      tag: "invalid-syntax",
    });
  });

  it("forbids hop-by-hop headers", () => {
    expect(thrown(() => new Fields().append("Transfer-Encoding", bytes("chunked")))).toEqual({
      tag: "forbidden",
    });
  });

  it("becomes immutable once a response owns it", () => {
    const headers = new Fields();
    new OutgoingResponse(headers);
    expect(thrown(() => headers.append("x-late", bytes("1")))).toEqual({ tag: "immutable" });
    expect(headers.clone().append("x-late", bytes("1"))).toBeUndefined();
  });
});

describe("InputStream", () => {
  it("reads in chunks and reports closed at the end", () => {
    const stream = new InputStream(bytes("abcdef"));
    expect(text(stream.read(4n))).toBe("abcd");
    expect(text(stream.blockingRead(100n))).toBe("ef");
    expect(thrown(() => stream.read(1n))).toEqual({ tag: "closed" });
  });
});

describe("OutgoingBody", () => {
  it("collects writes and closes its stream when finished", () => {
    const response = new OutgoingResponse(new Fields());
    const body = response.body();
    const stream = body.write();
    stream.write(bytes("hello "));
    stream.blockingWriteAndFlush(bytes("world"));
    OutgoingBody.finish(body, undefined);

    expect(thrown(() => stream.write(bytes("!")))).toEqual({ tag: "closed" });
    const snapshot = readOutgoingResponse(response);
    expect(snapshot.body?.finished).toBe(true);
    expect(text(snapshot.body?.bytes ?? new Uint8Array())).toBe("hello world");
  });

  it("hands out the body and its stream only once", () => {
    const response = new OutgoingResponse(new Fields());
    const body = response.body();
    body.write();
    expect(thrown(() => response.body())).toBeUndefined();
    expect(thrown(() => body.write())).toBeUndefined();
  });
});

describe("IncomingRequest", () => {
  it("maps methods, hides hop-by-hop headers, and lets the body be consumed once", () => {
    const request = new IncomingRequest({
      method: "PROPFIND",
      url: new URL("https://example.com:8443/a/b?c=1"),
      headers: new Headers({ "x-one": "1", connection: "keep-alive" }),
      body: bytes("payload"),
    });
    expect(request.method()).toEqual({ tag: "other", val: "PROPFIND" });
    expect(request.scheme()).toEqual({ tag: "HTTPS" });
    expect(request.authority()).toBe("example.com:8443");
    expect(request.pathWithQuery()).toBe("/a/b?c=1");
    expect(request.headers().has("x-one")).toBe(true);
    expect(request.headers().has("connection")).toBe(false);
    expect(text(request.consume().stream().read(100n))).toBe("payload");
    expect(thrown(() => request.consume())).toBeUndefined();

    const patch = new IncomingRequest({
      method: "PATCH",
      url: new URL("http://localhost/"),
      headers: new Headers(),
      body: new Uint8Array(0),
    });
    expect(patch.method()).toEqual({ tag: "patch" });
  });
});

describe("createLineSink", () => {
  it("forwards complete lines, and the remainder only at the end", () => {
    const lines: string[] = [];
    const sink = createLineSink((line) => lines.push(line));
    sink.write(bytes("first\nsec"));
    sink.write(bytes("ond\nthird"));
    expect(lines).toEqual(["first", "second"]);
    sink.end();
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("keeps a line whole when the guest flushes between writes", () => {
    const lines: string[] = [];
    const sink = createLineSink((line) => lines.push(line));
    for (const part of ["RuntimeError", ": ", "boom\n"]) {
      sink.write(bytes(part));
      sink.flush();
    }
    expect(lines).toEqual(["RuntimeError: boom"]);
  });
});
