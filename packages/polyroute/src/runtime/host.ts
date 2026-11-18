// An in-memory host for the WASI 0.2 interfaces an HTTP handler component
// imports. Request and response bodies are fully buffered, so every stream is
// always ready. A route that doesn't send outbound requests runs its `handle`
// export to completion synchronously. One that does is transpiled with JSPI,
// so `poll` and `pollable.block` can suspend it while a response arrives.

import type { SUPPORTED_INTERFACES } from "../interfaces.js";
import { createDeniedImports } from "./denied.js";
import {
  sendOutbound,
  toErrorCode,
  type OutboundPolicy,
  type OutboundResponse,
  type OutboundResult,
} from "./outbound.js";

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

/** Resolves at `deadline` without blocking the thread. `cancel` stops the timer early. */
function delayUntil(deadline: bigint): { promise: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, Number(deadline - monotonicNow()) / 1_000_000));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// wasi:io/poll

/** An operation, such as an outbound request, that a pollable can wait for. */
interface Pending {
  done: boolean;
  /** Resolves once `done` is true. Never rejects. */
  readonly promise: Promise<void>;
}

interface PollableState {
  deadline: bigint | undefined;
  pending: Pending | undefined;
  suspends: boolean;
}

let pollableState: (pollable: Pollable) => PollableState;

export class Pollable {
  readonly #deadline: bigint | undefined;
  readonly #pending: Pending | undefined;
  readonly #suspends: boolean;

  /**
   * A pollable without a deadline or a pending operation is always ready.
   * `suspends` is true in routes transpiled with JSPI, where waiting for a
   * deadline returns a promise instead of blocking the thread.
   */
  constructor(deadline?: bigint, suspends = false, pending?: Pending) {
    this.#deadline = deadline;
    this.#suspends = suspends;
    this.#pending = pending;
  }

  ready(): boolean {
    if (this.#pending !== undefined) return this.#pending.done;
    return this.#deadline === undefined || monotonicNow() >= this.#deadline;
  }

  block(): Promise<void> | undefined {
    if (this.ready()) return undefined;
    if (this.#pending !== undefined) return this.#pending.promise;
    if (this.#suspends) return delayUntil(this.#deadline!).promise;
    sleepUntil(this.#deadline!);
    return undefined;
  }

  static {
    pollableState = (pollable) => ({
      deadline: pollable.#deadline,
      pending: pollable.#pending,
      suspends: pollable.#suspends,
    });
  }
}

function readyIndexes(pollables: Pollable[]): Uint32Array | undefined {
  const ready: number[] = [];
  pollables.forEach((pollable, index) => {
    if (pollable.ready()) ready.push(index);
  });
  return ready.length > 0 ? Uint32Array.from(ready) : undefined;
}

function earliestDeadline(states: PollableState[]): bigint | undefined {
  let earliest: bigint | undefined;
  for (const { deadline, pending } of states) {
    if (pending !== undefined || deadline === undefined) continue;
    if (earliest === undefined || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

const WAITS_FOREVER = "wasi:io/poll#poll would wait forever: no pollable can become ready.";

/**
 * Returns the ready pollables' indexes. When none is ready, a route that
 * suspends gets a promise, and any other route blocks until a deadline passes.
 */
export function poll(pollables: Pollable[]): Uint32Array | Promise<Uint32Array> {
  if (pollables.length === 0) {
    throw new Error("wasi:io/poll#poll was called with an empty list.");
  }
  const ready = readyIndexes(pollables);
  if (ready !== undefined) return ready;
  const states = pollables.map(pollableState);
  if (states.some((state) => state.suspends || state.pending !== undefined)) {
    return pollSuspending(pollables, states);
  }
  for (;;) {
    const earliest = earliestDeadline(states);
    if (earliest === undefined) throw new Error(WAITS_FOREVER);
    sleepUntil(earliest);
    const ready = readyIndexes(pollables);
    if (ready !== undefined) return ready;
  }
}

async function pollSuspending(
  pollables: Pollable[],
  states: PollableState[],
): Promise<Uint32Array> {
  for (;;) {
    const waits = states.flatMap((state) =>
      state.pending === undefined ? [] : [state.pending.promise],
    );
    const earliest = earliestDeadline(states);
    const timer = earliest === undefined ? undefined : delayUntil(earliest);
    if (timer !== undefined) waits.push(timer.promise);
    if (waits.length === 0) throw new Error(WAITS_FOREVER);
    try {
      await Promise.race(waits);
    } finally {
      timer?.cancel();
    }
    const ready = readyIndexes(pollables);
    if (ready !== undefined) return ready;
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
export interface LineSink extends StreamSink {
  /** Forwards a final line that has no trailing newline. */
  end(): void;
}

/**
 * Forwards output line by line. A guest flush doesn't end the line: CPython
 * flushes stderr after every write, which would split a traceback mid-line.
 */
export function createLineSink(log: (line: string) => void): LineSink {
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
    flush() {},
    end() {
      pending += decoder.decode();
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
  dropped = false;
  /**
   * Called once the guest finishes the body (`true`) or drops it unfinished
   * (`false`). Outbound requests wait for it before they're sent.
   */
  onSettled: ((finished: boolean) => void) | undefined;

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
        val: "polyroute doesn't support trailers yet.",
      } satisfies ErrorCode;
    }
    body.#sink.finished = true;
    body.#sink.onSettled?.(true);
  }

  // jco calls this when the guest drops the body.
  [Symbol.dispose](): void {
    if (this.#sink.finished) return;
    this.#sink.dropped = true;
    this.#sink.onSettled?.(false);
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

// wasi:http outbound requests. Runtimes that bind the whole of wasi:http/types,
// such as componentize-py, reference these classes at instantiation even when
// the route can't send a request.

export class RequestOptions {
  #connectTimeout: bigint | undefined;
  #firstByteTimeout: bigint | undefined;
  #betweenBytesTimeout: bigint | undefined;

  connectTimeout(): bigint | undefined {
    return this.#connectTimeout;
  }

  setConnectTimeout(duration: bigint | undefined): void {
    this.#connectTimeout = duration;
  }

  firstByteTimeout(): bigint | undefined {
    return this.#firstByteTimeout;
  }

  setFirstByteTimeout(duration: bigint | undefined): void {
    this.#firstByteTimeout = duration;
  }

  betweenBytesTimeout(): bigint | undefined {
    return this.#betweenBytesTimeout;
  }

  setBetweenBytesTimeout(duration: bigint | undefined): void {
    this.#betweenBytesTimeout = duration;
  }
}

interface OutgoingRequestState {
  method: Method;
  pathWithQuery: string | undefined;
  scheme: Scheme | undefined;
  authority: string | undefined;
  headers: Fields;
  body: OutgoingBody | undefined;
}

let outgoingRequestState: (request: OutgoingRequest) => OutgoingRequestState;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

export class OutgoingRequest {
  readonly #headers: Fields;
  #method: Method = { tag: "get" };
  #pathWithQuery: string | undefined;
  #scheme: Scheme | undefined;
  #authority: string | undefined;
  #body: OutgoingBody | undefined;

  constructor(headers: Fields) {
    this.#headers = lockFields(headers);
  }

  body(): OutgoingBody {
    if (this.#body !== undefined) throw undefined;
    this.#body = new OutgoingBody();
    return this.#body;
  }

  method(): Method {
    return this.#method;
  }

  setMethod(method: Method): void {
    if (method.tag === "other" && !TOKEN.test(method.val)) throw undefined;
    this.#method = method;
  }

  pathWithQuery(): string | undefined {
    return this.#pathWithQuery;
  }

  setPathWithQuery(pathWithQuery: string | undefined): void {
    if (pathWithQuery !== undefined && /[\s#]/.test(pathWithQuery)) throw undefined;
    this.#pathWithQuery = pathWithQuery;
  }

  scheme(): Scheme | undefined {
    return this.#scheme;
  }

  setScheme(scheme: Scheme | undefined): void {
    if (scheme?.tag === "other" && !SCHEME.test(scheme.val)) throw undefined;
    this.#scheme = scheme;
  }

  authority(): string | undefined {
    return this.#authority;
  }

  setAuthority(authority: string | undefined): void {
    if (authority !== undefined && /[\s/?#@\\]/.test(authority)) throw undefined;
    this.#authority = authority;
  }

  headers(): Fields {
    return this.#headers;
  }

  static {
    outgoingRequestState = (request) => ({
      method: request.#method,
      pathWithQuery: request.#pathWithQuery,
      scheme: request.#scheme,
      authority: request.#authority,
      headers: request.#headers,
      body: request.#body,
    });
  }
}

export class IncomingResponse {
  readonly #status: number;
  readonly #headers: Fields;
  #body: Uint8Array | undefined;

  constructor(response: OutboundResponse) {
    const entries: Array<[string, Uint8Array]> = [];
    for (const [name, value] of response.headers) {
      if (!FORBIDDEN_HEADERS.has(name)) entries.push([name, latin1Encode(value)]);
    }
    this.#status = response.status;
    this.#headers = lockFields(Fields.fromList(entries));
    this.#body = response.body;
  }

  status(): number {
    return this.#status;
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

type IncomingResponseResult = { tag: "ok"; val: IncomingResponse } | { tag: "err"; val: ErrorCode };

function toIncomingResponse(result: OutboundResult): IncomingResponseResult {
  if (result.tag === "err") return result;
  try {
    return { tag: "ok", val: new IncomingResponse(result.val) };
  } catch {
    return {
      tag: "err",
      val: { tag: "internal-error", val: "The response had a header the route can't receive." },
    };
  }
}

export class FutureIncomingResponse {
  readonly #pending: Pending;
  #result: IncomingResponseResult | undefined;
  #taken = false;

  constructor(result: OutboundResult | Promise<OutboundResult>) {
    if (!(result instanceof Promise)) {
      this.#result = toIncomingResponse(result);
      this.#pending = { done: true, promise: Promise.resolve() };
      return;
    }
    const pending: Pending = {
      done: false,
      promise: result.then(
        (value) => {
          this.#result = toIncomingResponse(value);
          pending.done = true;
        },
        (error: unknown) => {
          this.#result = { tag: "err", val: toErrorCode(error) };
          pending.done = true;
        },
      ),
    };
    this.#pending = pending;
  }

  subscribe(): Pollable {
    return new Pollable(undefined, true, this.#pending);
  }

  get(): { tag: "ok"; val: IncomingResponseResult } | { tag: "err"; val: undefined } | undefined {
    if (!this.#pending.done) return undefined;
    if (this.#taken) return { tag: "err", val: undefined };
    this.#taken = true;
    return { tag: "ok", val: this.#result! };
  }
}

function whenBodySettled(sink: BodySink | undefined): boolean | Promise<boolean> {
  if (sink === undefined || sink.finished) return true;
  if (sink.dropped) return false;
  return new Promise((resolve) => {
    sink.onSettled = resolve;
  });
}

const DROPPED_BODY: OutboundResult = {
  tag: "err",
  val: { tag: "internal-error", val: "The route dropped the request body without finishing it." },
};

function toOutboundUrl(state: OutgoingRequestState): URL | undefined {
  const { scheme, authority, pathWithQuery = "/" } = state;
  if (scheme?.tag === "other" || authority === undefined || authority === "") return undefined;
  if (!pathWithQuery.startsWith("/")) return undefined;
  const protocol = scheme?.tag === "HTTP" ? "http" : "https";
  try {
    return new URL(`${protocol}://${authority}${pathWithQuery}`);
  } catch {
    return undefined;
  }
}

/**
 * `wasi:http/outgoing-handler#handle`. Every failure, including a denied
 * host, comes back through the future: wstd traps if `handle` itself fails.
 */
function handleOutgoing(
  outbound: OutboundContext | undefined,
  request: OutgoingRequest,
  options: RequestOptions | undefined,
): FutureIncomingResponse {
  const state = outgoingRequestState(request);
  const url = toOutboundUrl(state);
  if (url === undefined) {
    return new FutureIncomingResponse({ tag: "err", val: { tag: "HTTP-request-URI-invalid" } });
  }
  if (outbound === undefined || !outbound.policy.allows(url)) {
    return new FutureIncomingResponse({ tag: "err", val: { tag: "HTTP-request-denied" } });
  }
  const sink = state.body === undefined ? undefined : outgoingBodySink(state.body);
  const send = (finished: boolean): OutboundResult | Promise<OutboundResult> => {
    if (!finished) return DROPPED_BODY;
    return sendOutbound(
      {
        method: state.method.tag === "other" ? state.method.val : state.method.tag.toUpperCase(),
        url,
        headers: state.headers.entries().map(([name, value]) => [name, latin1Decode(value)]),
        body: sink?.bytes(),
        connectTimeout: options?.connectTimeout(),
        firstByteTimeout: options?.firstByteTimeout(),
        betweenBytesTimeout: options?.betweenBytesTimeout(),
      },
      signal,
    );
  };
  // The guest usually writes the body after `handle` returns, so the request
  // is sent once the body is finished.
  const signal = outbound.signal;
  const settled = whenBodySettled(sink);
  return new FutureIncomingResponse(
    typeof settled === "boolean" ? send(settled) : settled.then(send),
  );
}

// wasi:cli

class TerminalInput {}
class TerminalOutput {}

export interface OutboundContext {
  readonly policy: OutboundPolicy;
  /** The signal of the request the guest is handling, aborted when it ends. */
  signal: AbortSignal | undefined;
}

export interface HostContext {
  stdout: StreamSink;
  stderr: StreamSink;
  /**
   * Set for a route that imports `wasi:http/outgoing-handler`. polyroute
   * transpiles such a route with JSPI, so its waits suspend instead of block.
   */
  outbound?: OutboundContext | undefined;
}

export type HostImports = Record<(typeof SUPPORTED_INTERFACES)[number], Record<string, unknown>>;

/** Builds the import object for one instance. Classes are shared; sinks are per request. */
export function createImports(context: HostContext): HostImports {
  const suspends = context.outbound !== undefined;
  return {
    ...createDeniedImports(),
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
      subscribeInstant: (when: bigint) => new Pollable(when, suspends),
      subscribeDuration: (duration: bigint) => new Pollable(monotonicNow() + duration, suspends),
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
      OutgoingRequest,
      RequestOptions,
      IncomingResponse,
      FutureIncomingResponse,
      httpErrorCode: (_error: IoError): ErrorCode | undefined => undefined,
    },
    "wasi:http/outgoing-handler": {
      handle: (request: OutgoingRequest, options: RequestOptions | undefined) =>
        handleOutgoing(context.outbound, request, options),
    },
  };
}
