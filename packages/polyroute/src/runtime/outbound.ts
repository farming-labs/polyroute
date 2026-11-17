// Outbound HTTP for routes that import `wasi:http/outgoing-handler`: which
// hosts a route may call, and how a buffered request becomes a `fetch`.

import { PolyrouteError } from "../errors.js";
import type { ErrorCode } from "./host.js";

/** Lets routes send HTTP requests. Routes can't send any unless this is set. */
export interface OutboundOptions {
  /**
   * Hosts the route may send requests to. Each entry is one of:
   *
   * - a hostname, such as `"api.example.com"`, on any port
   * - a hostname and port, such as `"localhost:8787"`
   * - `"*."` and a domain, such as `"*.example.com"`, for its subdomains but
   *   not the domain itself, optionally with a port
   * - `"*"` for any host
   *
   * A request to any other host fails with the `wasi:http` error
   * `HTTP-request-denied`, which the route sees as an error from its client.
   */
  allow: readonly string[];
}

export interface OutboundPolicy {
  readonly allow: readonly string[];
  allows(url: URL): boolean;
}

type AllowRule =
  | { kind: "any" }
  | { kind: "host" | "subdomains"; hostname: string; port: string | undefined };

const ENTRY_EXAMPLES = "`api.example.com`, `localhost:8787`, `*.example.com`, or `*`";

function parseAllowEntry(entry: unknown): AllowRule | undefined {
  if (typeof entry !== "string") return undefined;
  if (entry === "*") return { kind: "any" };
  const subdomains = entry.startsWith("*.");
  const host = subdomains ? entry.slice(2) : entry;
  if (host === "" || /[\s/?#@\\*]/.test(host)) return undefined;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  // `URL` drops a port that's the default for `http:`, so read it from the entry.
  const port = /:\d+$/.test(host) ? host.slice(host.lastIndexOf(":") + 1) : undefined;
  return { kind: subdomains ? "subdomains" : "host", hostname: url.hostname, port };
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/** Validates `outbound` and returns the policy every outbound request is checked against. */
export function createOutboundPolicy(options: OutboundOptions): OutboundPolicy {
  const allow = (options as Partial<OutboundOptions> | null)?.allow;
  if (!Array.isArray(allow)) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`outbound.allow\` must be a list of hosts, such as ${ENTRY_EXAMPLES}, but it's ${JSON.stringify(allow)}.`,
    );
  }
  const rules: AllowRule[] = [];
  const invalid: string[] = [];
  for (const entry of allow) {
    const rule = parseAllowEntry(entry);
    if (rule === undefined) invalid.push(JSON.stringify(entry));
    else rules.push(rule);
  }
  if (invalid.length > 0) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `Every \`outbound.allow\` entry must be a host such as ${ENTRY_EXAMPLES}, without a scheme or path. These aren't: ${invalid.join(", ")}.`,
    );
  }
  return {
    allow: [...allow],
    allows(url) {
      const port = effectivePort(url);
      return rules.some((rule) => {
        if (rule.kind === "any") return true;
        if (rule.port !== undefined && rule.port !== port) return false;
        return rule.kind === "host"
          ? url.hostname === rule.hostname
          : url.hostname.endsWith(`.${rule.hostname}`);
      });
    },
  };
}

export interface OutboundRequest {
  method: string;
  url: URL;
  headers: Array<[string, string]>;
  body: Uint8Array<ArrayBuffer> | undefined;
  /** Nanoseconds, from `request-options`. */
  connectTimeout: bigint | undefined;
  firstByteTimeout: bigint | undefined;
  betweenBytesTimeout: bigint | undefined;
}

export interface OutboundResponse {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export type OutboundResult = { tag: "ok"; val: OutboundResponse } | { tag: "err"; val: ErrorCode };

// `fetch` decodes these and hands back the decoded body, but keeps the
// response's `content-encoding` and `content-length`. A route that forwarded
// those headers would describe bytes it doesn't have.
const DECODED_ENCODINGS = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);

// Headers `fetch` manages itself or won't send.
const FETCH_MANAGED_HEADERS = new Set(["content-length"]);

class OutboundTimeout extends Error {
  constructor(readonly code: ErrorCode) {
    super(code.tag);
  }
}

function toMs(nanoseconds: bigint): number {
  return Number(nanoseconds / 1_000_000n);
}

/**
 * Rejects with an {@link OutboundTimeout} after `ms`. The returned `cancel`
 * stops the timer once the race it's in has settled.
 */
function timeout(ms: number, code: ErrorCode): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OutboundTimeout(code)), ms);
  });
  // Nothing awaits a timeout that lost its race.
  promise.catch(() => {});
  return { promise, cancel: () => clearTimeout(timer) };
}

async function race<T>(
  work: Promise<T>,
  limit: { promise: Promise<never>; cancel(): void } | undefined,
): Promise<T> {
  if (limit === undefined) return work;
  try {
    return await Promise.race([work, limit.promise]);
  } finally {
    limit.cancel();
  }
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  betweenBytesMs: number | undefined,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const limit =
        betweenBytesMs === undefined
          ? undefined
          : timeout(betweenBytesMs, { tag: "connection-read-timeout" });
      const { done, value } = await race(reader.read(), limit);
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const TLS_CERTIFICATE_CODES =
  /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|ERR_TLS_CERT_ALTNAME_INVALID$|HOSTNAME_MISMATCH$)/;

function errorCodeOf(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

function describe(error: unknown): string {
  const messages: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages.join(": ") : String(error);
}

/** Maps a failed `fetch` to the closest `wasi:http` error code. */
export function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof OutboundTimeout) return error.code;
  const code = errorCodeOf(error);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_NONAME":
    case "EAI_NODATA":
      return { tag: "DNS-error", val: { rcode: undefined, infoCode: undefined } };
    case "EAI_AGAIN":
      return { tag: "DNS-timeout" };
    case "ECONNREFUSED":
      return { tag: "connection-refused" };
    case "ECONNRESET":
    case "EPIPE":
    case "UND_ERR_SOCKET":
    case "UND_ERR_CLOSED":
      return { tag: "connection-terminated" };
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return { tag: "connection-timeout" };
    case "UND_ERR_HEADERS_TIMEOUT":
      return { tag: "HTTP-response-timeout" };
    case "UND_ERR_BODY_TIMEOUT":
      return { tag: "connection-read-timeout" };
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return { tag: "destination-unavailable" };
    case "EPROTO":
      return { tag: "TLS-protocol-error" };
  }
  if (code !== undefined && TLS_CERTIFICATE_CODES.test(code))
    return { tag: "TLS-certificate-error" };
  if (code?.startsWith("ERR_SSL_")) return { tag: "TLS-protocol-error" };
  return { tag: "internal-error", val: describe(error) };
}

/**
 * Sends a request the route built and reads the whole response. Never
 * rejects: a failure becomes the `wasi:http` error code the route receives.
 */
export async function sendOutbound(
  request: OutboundRequest,
  signal: AbortSignal | undefined,
): Promise<OutboundResult> {
  try {
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!FETCH_MANAGED_HEADERS.has(name)) headers.append(name, value);
    }
    // Without this, `fetch` asks for a compressed response it then decodes,
    // so the route would never see the upstream's real `content-length`.
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");

    // wstd and Go send an empty body with every request, and `fetch` refuses
    // any body, even an empty one, with GET and HEAD.
    const body = request.body !== undefined && request.body.length > 0 ? request.body : null;
    const method = request.method.toUpperCase();
    if (body !== null && (method === "GET" || method === "HEAD")) {
      return { tag: "err", val: { tag: "HTTP-request-method-invalid" } };
    }

    const headersTimeoutNs =
      request.connectTimeout === undefined && request.firstByteTimeout === undefined
        ? undefined
        : (request.connectTimeout ?? 0n) + (request.firstByteTimeout ?? 0n);
    const headersLimit =
      headersTimeoutNs === undefined
        ? undefined
        : timeout(toMs(headersTimeoutNs), {
            tag:
              request.firstByteTimeout === undefined
                ? "connection-timeout"
                : "connection-read-timeout",
          });

    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await race(
        fetch(request.url, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        }),
        headersLimit,
      ).catch((error: unknown) => {
        controller.abort();
        throw error;
      });

      const betweenBytesMs =
        request.betweenBytesTimeout === undefined ? undefined : toMs(request.betweenBytesTimeout);
      const responseBody = await readBody(response.body, betweenBytesMs);

      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const decoded = encoding !== undefined && DECODED_ENCODINGS.has(encoding);
      const responseHeaders: Array<[string, string]> = [];
      response.headers.forEach((value, name) => {
        if (decoded && (name === "content-encoding" || name === "content-length")) return;
        if (name === "set-cookie") return;
        responseHeaders.push([name, value]);
      });
      for (const cookie of response.headers.getSetCookie())
        responseHeaders.push(["set-cookie", cookie]);
      return {
        tag: "ok",
        val: { status: response.status, headers: responseHeaders, body: responseBody },
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    return { tag: "err", val: toErrorCode(error) };
  }
}
