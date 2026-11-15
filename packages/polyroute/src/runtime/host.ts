// An in-memory host for the WASI 0.2 interfaces an HTTP handler component
// imports. Request and response bodies are fully buffered, so every stream is
// always ready and the guest's `handle` export runs to completion synchronously.

import type { SUPPORTED_INTERFACES } from "../interfaces.js";

type StreamError = { tag: "closed" };
type HeaderError = { tag: "invalid-syntax" } | { tag: "forbidden" } | { tag: "immutable" };

export type ErrorCode = { tag: string; val?: unknown };
export type ResponseResult = { tag: "ok"; val: OutgoingResponse } | { tag: "err"; val: ErrorCode };

const KNOWN_METHODS = [
  "get",
  "head",
  "post",
  "put",
  "delete",
  "connect",
  "options",
  "trace",
  "patch",
] as const;
type KnownMethod = (typeof KNOWN_METHODS)[number];
type Method = { tag: KnownMethod } | { tag: "other"; val: string };
type Scheme = { tag: "HTTP" } | { tag: "HTTPS" } | { tag: "other"; val: string };

/** Hop-by-hop headers a route can't read or set, matching what wasi:http hosts forbid. */
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
  "http2-settings",
]);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const WRITE_BUDGET = 1n << 20n;
const RANDOM_CHUNK = 65_536;

const closed = (): StreamError => ({ tag: "closed" });

function toSafeLength(length: bigint): number {
  return length > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(length);
}

export function latin1Encode(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
}

export function latin1Decode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

// wasi:io/error

export class IoError {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  toDebugString(): string {
    return this.#message;
  }
}

// wasi:clocks

function monotonicNow(): bigint {
  return BigInt(Math.round(performance.now() * 1_000_000));
}

let sleepCell: Int32Array | undefined;

function sleepUntil(deadline: bigint): void {
  const remainingMs = Number(deadline - monotonicNow()) / 1_000_000;
  if (remainingMs <= 0) return;
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "Route timers need Atomics.wait, which this JavaScript runtime doesn't provide.",
    );
  }
  sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepCell, 0, 0, remainingMs);
}

// wasi:io/poll

let pollableDeadline: (pollable: Pollable) => bigint | undefined;

export class Pollable {
  readonly #deadline: bigint | undefined;

  /** A pollable without a deadline is always ready. */
  constructor(deadline?: bigint) {
    this.#deadline = deadline;
  }

  ready(): boolean {
    return this.#deadline === undefined || monotonicNow() >= this.#deadline;
  }

  block(): void {
    if (this.#deadline !== undefined) sleepUntil(this.#deadline);
  }

  static {
    pollableDeadline = (pollable) => pollable.#deadline;
  }
}

export function poll(pollables: Pollable[]): Uint32Array {
  if (pollables.length === 0) {
    throw new Error("wasi:io/poll#poll was called with an empty list.");
  }
  for (;;) {
    const ready: number[] = [];
    let earliest: bigint | undefined;
    pollables.forEach((pollable, index) => {
      if (pollable.ready()) {
        ready.push(index);
        return;
      }
      const deadline = pollableDeadline(pollable);
      if (deadline !== undefined && (earliest === undefined || deadline < earliest)) {
        earliest = deadline;
      }
    });
    if (ready.length > 0) return Uint32Array.from(ready);
    if (earliest === undefined) {
      throw new Error("wasi:io/poll#poll would wait forever: no pollable can become ready.");
    }
    sleepUntil(earliest);
  }
}

// wasi:io/streams

export interface StreamSink {
  write(bytes: Uint8Array): void;
  flush(): void;
  isClosed(): boolean;
}

export class InputStream {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  read(length: bigint): Uint8Array {
    const remaining = this.#bytes.length - this.#offset;
    if (remaining === 0) throw closed();
    const size = Math.min(remaining, toSafeLength(length));
    const chunk = this.#bytes.slice(this.#offset, this.#offset + size);
    this.#offset += size;
    return chunk;
  }

  blockingRead(length: bigint): Uint8Array {
    return this.read(length);
  }

  skip(length: bigint): bigint {
    const remaining = this.#bytes.length - this.#offset;
    if (remaining === 0) throw closed();
    const size = Math.min(remaining, toSafeLength(length));
    this.#offset += size;
    return BigInt(size);
  }

  blockingSkip(length: bigint): bigint {
    return this.skip(length);
  }

  subscribe(): Pollable {
    return new Pollable();
  }
}

export class OutputStream {
  readonly #sink: StreamSink;

  constructor(sink: StreamSink) {
    this.#sink = sink;
  }

  checkWrite(): bigint {
    this.#ensureOpen();
    return WRITE_BUDGET;
  }

  write(contents: Uint8Array): void {
    this.#ensureOpen();
    this.#sink.write(contents.slice());
  }

  blockingWriteAndFlush(contents: Uint8Array): void {
    this.write(contents);
    this.#sink.flush();
  }

  flush(): void {
    this.#ensureOpen();
    this.#sink.flush();
  }

  blockingFlush(): void {
    this.flush();
  }

  subscribe(): Pollable {
    return new Pollable();
  }

  writeZeroes(length: bigint): void {
    this.write(new Uint8Array(toSafeLength(length)));
  }

  blockingWriteZeroesAndFlush(length: bigint): void {
    this.writeZeroes(length);
    this.#sink.flush();
  }

  splice(source: InputStream, length: bigint): bigint {
    this.#ensureOpen();
    const chunk = source.read(length);
    this.#sink.write(chunk);
    return BigInt(chunk.length);
  }

  blockingSplice(source: InputStream, length: bigint): bigint {
    return this.splice(source, length);
  }

  #ensureOpen(): void {
    if (this.#sink.isClosed()) throw closed();
  }
}

/** A stdout/stderr sink that forwards complete lines to `log`. */
export function createLineSink(log: (line: string) => void): StreamSink {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    write(bytes) {
      pending += decoder.decode(bytes, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        log(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length > 0) {
        log(pending);
        pending = "";
      }
    },
    isClosed: () => false,
  };
}

class BodySink implements StreamSink {
  readonly chunks: Uint8Array[] = [];
  size = 0;
  finished = false;

  write(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.size += bytes.length;
  }

  flush(): void {}

  isClosed(): boolean {
    return this.finished;
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}

// wasi:http/types

const immutableFields = new WeakSet<Fields>();

function checkName(name: string): string {
  if (!TOKEN.test(name)) throw { tag: "invalid-syntax" } satisfies HeaderError;
  const key = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(key)) throw { tag: "forbidden" } satisfies HeaderError;
  return key;
}

function checkValue(value: Uint8Array): void {
  for (const byte of value) {
    if (byte === 0x00 || byte === 0x0a || byte === 0x0d) {
      throw { tag: "invalid-syntax" } satisfies HeaderError;
    }
  }
}

export class Fields {
  #entries: Array<[string, Uint8Array]> = [];

  static fromList(entries: Array<[string, Uint8Array]>): Fields {
    const fields = new Fields();
    for (const [name, value] of entries) {
      const key = checkName(name);
      checkValue(value);
      fields.#entries.push([key, value.slice()]);
    }
    return fields;
  }

  get(name: string): Uint8Array[] {
    const key = name.toLowerCase();
    return this.#entries.filter(([entry]) => entry === key).map(([, value]) => value.slice());
  }

  has(name: string): boolean {
    const key = name.toLowerCase();
    return this.#entries.some(([entry]) => entry === key);
  }

  set(name: string, values: Uint8Array[]): void {
    this.#ensureMutable();
    const key = checkName(name);
    values.forEach(checkValue);
    this.#entries = this.#entries.filter(([entry]) => entry !== key);
    for (const value of values) this.#entries.push([key, value.slice()]);
  }

  delete(name: string): void {
    this.#ensureMutable();
    const key = checkName(name);
    this.#entries = this.#entries.filter(([entry]) => entry !== key);
  }

  append(name: string, value: Uint8Array): void {
    this.#ensureMutable();
    const key = checkName(name);
    checkValue(value);
    this.#entries.push([key, value.slice()]);
  }

  entries(): Array<[string, Uint8Array]> {
    return this.#entries.map(([name, value]) => [name, value.slice()]);
  }

  clone(): Fields {
    const fields = new Fields();
    fields.#entries = this.entries();
    return fields;
  }

  #ensureMutable(): void {
    if (immutableFields.has(this)) throw { tag: "immutable" } satisfies HeaderError;
  }
}

function lockFields(fields: Fields): Fields {
  immutableFields.add(fields);
  return fields;
}

function toMethod(method: string): Method {
  const known = KNOWN_METHODS.find((candidate) => candidate.toUpperCase() === method);
  return known === undefined ? { tag: "other", val: method } : { tag: known };
}

function toScheme(protocol: string): Scheme {
  if (protocol === "http:") return { tag: "HTTP" };
  if (protocol === "https:") return { tag: "HTTPS" };
  return { tag: "other", val: protocol.replace(/:$/, "") };
}

export interface IncomingRequestInit {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array;
}

export class IncomingRequest {
  readonly #method: Method;
  readonly #pathWithQuery: string;
  readonly #scheme: Scheme;
  readonly #authority: string;
  readonly #headers: Fields;
  #body: Uint8Array | undefined;

  constructor(init: IncomingRequestInit) {
    const entries: Array<[string, Uint8Array]> = [];
    init.headers.forEach((value, name) => {
      if (!FORBIDDEN_HEADERS.has(name)) entries.push([name, latin1Encode(value)]);
    });
    this.#method = toMethod(init.method);
    this.#pathWithQuery = init.url.pathname + init.url.search;
    this.#scheme = toScheme(init.url.protocol);
    this.#authority = init.url.host;
    this.#headers = lockFields(Fields.fromList(entries));
    this.#body = init.body;
  }

  method(): Method {
    return this.#method;
  }

  pathWithQuery(): string | undefined {
    return this.#pathWithQuery;
  }

  scheme(): Scheme | undefined {
    return this.#scheme;
  }

  authority(): string | undefined {
    return this.#authority;
  }

  headers(): Fields {
    return this.#headers;
  }

  consume(): IncomingBody {
    if (this.#body === undefined) throw undefined;
    const body = new IncomingBody(this.#body);
    this.#body = undefined;
    return body;
  }
}

export class IncomingBody {
  #stream: InputStream | undefined;

  constructor(bytes: Uint8Array) {
    this.#stream = new InputStream(bytes);
  }

  stream(): InputStream {
    if (this.#stream === undefined) throw undefined;
    const stream = this.#stream;
    this.#stream = undefined;
    return stream;
  }

  static finish(_body: IncomingBody): FutureTrailers {
    return new FutureTrailers();
  }
}

export class FutureTrailers {
  #taken = false;

  subscribe(): Pollable {
    return new Pollable();
  }

  get(): { tag: "ok"; val: { tag: "ok"; val: undefined } } | { tag: "err"; val: undefined } {
    if (this.#taken) return { tag: "err", val: undefined };
    this.#taken = true;
    return { tag: "ok", val: { tag: "ok", val: undefined } };
  }
}

let outgoingBodySink: (body: OutgoingBody) => BodySink;

export class OutgoingBody {
  readonly #sink = new BodySink();
  #streamTaken = false;

  write(): OutputStream {
    if (this.#streamTaken) throw undefined;
    this.#streamTaken = true;
    return new OutputStream(this.#sink);
  }

  static finish(body: OutgoingBody, trailers: Fields | undefined): void {
    if (trailers !== undefined) {
      throw {
        tag: "internal-error",
        val: "polyroute doesn't support response trailers yet.",
      } satisfies ErrorCode;
    }
    body.#sink.finished = true;
  }

  static {
    outgoingBodySink = (body) => body.#sink;
  }
}

let outgoingResponseState: (response: OutgoingResponse) => {
  status: number;
  headers: Fields;
  body: OutgoingBody | undefined;
};

export class OutgoingResponse {
  readonly #headers: Fields;
  #status = 200;
  #body: OutgoingBody | undefined;

  constructor(headers: Fields) {
    this.#headers = lockFields(headers);
  }

  statusCode(): number {
    return this.#status;
  }

  setStatusCode(status: number): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) throw undefined;
    this.#status = status;
  }

  headers(): Fields {
    return this.#headers;
  }

  body(): OutgoingBody {
    if (this.#body !== undefined) throw undefined;
    this.#body = new OutgoingBody();
    return this.#body;
  }

  static {
    outgoingResponseState = (response) => ({
      status: response.#status,
      headers: response.#headers,
      body: response.#body,
    });
  }
}

export class ResponseOutparam {
  readonly #onSet: (result: ResponseResult) => void;
  #used = false;

  constructor(onSet: (result: ResponseResult) => void) {
    this.#onSet = onSet;
  }

  static set(param: ResponseOutparam, response: ResponseResult): void {
    if (param.#used) throw new Error("response-outparam.set was called twice.");
    param.#used = true;
    param.#onSet(response);
  }
}

export interface OutgoingResponseSnapshot {
  status: number;
  headers: Array<[string, Uint8Array]>;
  /** `undefined` when the route never asked for a body. */
  body: { bytes: Uint8Array<ArrayBuffer>; finished: boolean } | undefined;
}

export function readOutgoingResponse(response: OutgoingResponse): OutgoingResponseSnapshot {
  const { status, headers, body } = outgoingResponseState(response);
  if (body === undefined) return { status, headers: headers.entries(), body: undefined };
  const sink = outgoingBodySink(body);
  return {
    status,
    headers: headers.entries(),
    body: { bytes: sink.bytes(), finished: sink.finished },
  };
}

// wasi:random

function randomBytes(length: bigint): Uint8Array {
  const bytes = new Uint8Array(toSafeLength(length));
  for (let offset = 0; offset < bytes.length; offset += RANDOM_CHUNK) {
    crypto.getRandomValues(bytes.subarray(offset, offset + RANDOM_CHUNK));
  }
  return bytes;
}

function randomU64(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n;
}

// wasi:cli

class TerminalInput {}
class TerminalOutput {}

export interface HostContext {
  stdout: StreamSink;
  stderr: StreamSink;
}

export type HostImports = Record<(typeof SUPPORTED_INTERFACES)[number], Record<string, unknown>>;

/** Builds the import object for one instance. Classes are shared; sinks are per request. */
export function createImports(context: HostContext): HostImports {
  return {
    "wasi:cli/environment": {
      getEnvironment: (): Array<[string, string]> => [],
      getArguments: (): string[] => [],
      initialCwd: (): string | undefined => undefined,
    },
    "wasi:cli/exit": {
      exit(status: { tag: "ok" | "err" }): never {
        throw new Error(
          `The route called exit with ${status.tag === "ok" ? "success" : "failure"}.`,
        );
      },
      exitWithCode(code: number): never {
        throw new Error(`The route called exit with code ${code}.`);
      },
    },
    "wasi:cli/stdin": {
      getStdin: () => new InputStream(new Uint8Array(0)),
    },
    "wasi:cli/stdout": {
      getStdout: () => new OutputStream(context.stdout),
    },
    "wasi:cli/stderr": {
      getStderr: () => new OutputStream(context.stderr),
    },
    "wasi:cli/terminal-input": { TerminalInput },
    "wasi:cli/terminal-output": { TerminalOutput },
    "wasi:cli/terminal-stdin": { getTerminalStdin: () => undefined },
    "wasi:cli/terminal-stdout": { getTerminalStdout: () => undefined },
    "wasi:cli/terminal-stderr": { getTerminalStderr: () => undefined },
    "wasi:clocks/monotonic-clock": {
      now: monotonicNow,
      resolution: () => 1_000n,
      subscribeInstant: (when: bigint) => new Pollable(when),
      subscribeDuration: (duration: bigint) => new Pollable(monotonicNow() + duration),
    },
    "wasi:clocks/wall-clock": {
      now() {
        const ms = Date.now();
        return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
      },
      resolution: () => ({ seconds: 0n, nanoseconds: 1_000_000 }),
    },
    "wasi:io/error": { Error: IoError },
    "wasi:io/poll": { Pollable, poll },
    "wasi:io/streams": { InputStream, OutputStream },
    "wasi:random/random": { getRandomBytes: randomBytes, getRandomU64: randomU64 },
    "wasi:random/insecure": {
      getInsecureRandomBytes: randomBytes,
      getInsecureRandomU64: randomU64,
    },
    "wasi:random/insecure-seed": {
      insecureSeed: (): [bigint, bigint] => [randomU64(), randomU64()],
    },
    "wasi:http/types": {
      Fields,
      IncomingRequest,
      IncomingBody,
      FutureTrailers,
      OutgoingResponse,
      OutgoingBody,
      ResponseOutparam,
      httpErrorCode: (_error: IoError): ErrorCode | undefined => undefined,
    },
  };
}
