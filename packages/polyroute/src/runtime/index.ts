import { PolyrouteError } from "../errors.js";
import {
  IncomingRequest,
  ResponseOutparam,
  createImports,
  createLineSink,
  latin1Decode,
  readOutgoingResponse,
  type ErrorCode,
  type HostImports,
  type LineSink,
  type OutgoingResponse,
  type ResponseResult,
  type StreamSink,
} from "./host.js";

export { PolyrouteError, type PolyrouteErrorCode } from "../errors.js";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface RouteInstance {
  incomingHandler: {
    handle(request: IncomingRequest, responseOut: ResponseOutparam): void;
  };
  _util?: { stop(): void };
}

/** The `instantiate` export of a component transpiled by jco with `instantiation: "async"`. */
export type InstantiateRoute = (
  getCoreModule: (path: string) => Promise<WebAssembly.Module>,
  imports: HostImports,
) => RouteInstance | Promise<RouteInstance>;

/**
 * How a route's requests map to instances of its component.
 *
 * - `"reuse"`: one instance serves every request, one request at a time, like a
 *   long-running server process. Global state persists between requests. An
 *   instance that traps is thrown away, and the next request gets a new one.
 * - `"per-request"`: every request gets a fresh instance, so nothing survives
 *   a request. Instantiating costs far more than most handlers do.
 */
export type InstanceMode = "reuse" | "per-request";

export const INSTANCE_MODES: readonly InstanceMode[] = ["reuse", "per-request"];

export interface WasiHttpHandlerOptions {
  /** The route's source path, used in error messages. */
  route: string;
  instantiate: InstantiateRoute;
  /**
   * Core Wasm modules of the transpiled component, keyed by file name. Each is
   * either the module's bytes, base64-encoded, or the `file:` URL of a file the
   * build wrote next to the bundle.
   */
  coreModules: Readonly<Record<string, string | URL>>;
  /** Defaults to `"reuse"`. */
  instances?: InstanceMode;
  /**
   * Replaces a reused instance after it has served this many requests, for
   * guests whose memory grows with every request. Defaults to no limit.
   */
  requestsPerInstance?: number;
}

export interface WasiHttpRoute {
  readonly route: string;
  readonly fetch: FetchHandler;
}

const STDERR_TAIL_LINES = 20;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const native = (
    Uint8Array as unknown as { fromBase64?: (value: string) => Uint8Array<ArrayBuffer> }
  ).fromBase64;
  if (typeof native === "function") return native(encoded);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// The import is dynamic so the runtime still loads where there is no
// `node:fs`, as long as every core module is inline.
async function readCoreModuleFile(
  route: string,
  name: string,
  url: URL,
): Promise<Uint8Array<ArrayBuffer>> {
  if (url.protocol !== "file:") {
    throw new PolyrouteError(
      "ROUTE_INSTANTIATION_FAILED",
      `Route \`${route}\` can only read its core module \`${name}\` from a \`file:\` URL, but it got \`${url.href}\`.`,
    );
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(url);
  } catch (error) {
    throw new PolyrouteError(
      "ROUTE_INSTANTIATION_FAILED",
      `Route \`${route}\` couldn't read its core module \`${name}\` (${error instanceof Error ? error.message : String(error)}). Deploy the \`polyroute\` directory that \`vite build\` writes next to the server bundle.`,
      { cause: error },
    );
  }
}

function describeErrorCode(code: ErrorCode): string {
  return typeof code.val === "string" ? `${code.tag}: ${code.val}` : code.tag;
}

/**
 * The guest keeps the stdout and stderr streams it got at startup, so a reused
 * instance writes through a relay that points at the current request's output.
 */
interface Relay extends StreamSink {
  target: LineSink;
}

function createRelay(target: LineSink): Relay {
  return {
    target,
    write(bytes) {
      this.target.write(bytes);
    },
    flush() {
      this.target.flush();
    },
    isClosed: () => false,
  };
}

interface Slot {
  instance: RouteInstance;
  stdout: Relay;
  stderr: Relay;
  served: number;
  retired: boolean;
}

/**
 * Wraps a transpiled `wasi:http` component as a web-standard fetch handler.
 * See {@link InstanceMode} for how requests share instances.
 */
export function createWasiHttpHandler(options: WasiHttpHandlerOptions): WasiHttpRoute {
  const { route, requestsPerInstance = Infinity } = options;
  if (
    requestsPerInstance !== Infinity &&
    !(Number.isInteger(requestsPerInstance) && requestsPerInstance > 0)
  ) {
    throw new PolyrouteError(
      "INVALID_OPTIONS",
      `\`requestsPerInstance\` must be a positive integer, but it's ${String(requestsPerInstance)}.`,
    );
  }
  const reuse = (options.instances ?? "reuse") === "reuse";
  const compiled = new Map<string, Promise<WebAssembly.Module>>();
  // Output written outside a request, such as while a reused instance starts.
  const idle = {
    stdout: createLineSink((line) => console.log(line)),
    stderr: createLineSink((line) => console.error(line)),
  };

  const getCoreModule = (path: string): Promise<WebAssembly.Module> => {
    let module = compiled.get(path);
    if (module === undefined) {
      const source = options.coreModules[path];
      if (source === undefined) {
        return Promise.reject(
          new PolyrouteError(
            "ROUTE_INSTANTIATION_FAILED",
            `Route \`${route}\` asked for the core module \`${path}\`, which wasn't bundled. Rebuild the app so the route is transpiled again.`,
          ),
        );
      }
      const pending =
        typeof source === "string"
          ? WebAssembly.compile(decodeBase64(source))
          : readCoreModuleFile(route, path, source).then((bytes) => WebAssembly.compile(bytes));
      compiled.set(path, pending);
      // A failed read or compile isn't kept, so the next request tries again.
      pending.catch(() => {
        if (compiled.get(path) === pending) compiled.delete(path);
      });
      module = pending;
    }
    return module;
  };

  const instantiateSlot = async (stdout: LineSink, stderr: LineSink): Promise<Slot> => {
    const relays = { stdout: createRelay(stdout), stderr: createRelay(stderr) };
    try {
      const instance = await options.instantiate(getCoreModule, createImports(relays));
      return { instance, ...relays, served: 0, retired: false };
    } catch (error) {
      if (error instanceof PolyrouteError) throw error;
      throw new PolyrouteError(
        "ROUTE_INSTANTIATION_FAILED",
        `Route \`${route}\` couldn't be instantiated: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  let shared: Promise<Slot> | undefined;
  let sharedSlot: Slot | undefined;

  const acquireShared = async (): Promise<Slot> => {
    while (true) {
      if (shared === undefined) {
        const pending = instantiateSlot(idle.stdout, idle.stderr);
        shared = pending;
        pending.then(
          (slot) => {
            if (shared === pending) sharedSlot = slot;
            idle.stdout.end();
            idle.stderr.end();
          },
          // A failed start isn't kept, so the next request tries again.
          () => {
            if (shared === pending) shared = undefined;
          },
        );
      }
      const current = shared;
      const slot = await current;
      // Another request may have retired this instance while this one waited.
      if (!slot.retired) return slot;
      if (shared === current) shared = undefined;
    }
  };

  const retire = (slot: Slot): void => {
    slot.retired = true;
    if (slot === sharedSlot) {
      shared = undefined;
      sharedSlot = undefined;
    }
    slot.instance._util?.stop();
  };

  const fetch: FetchHandler = async (request) => {
    const url = new URL(request.url);
    const body =
      request.body === null ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());

    const stderrTail: string[] = [];
    const stdout = createLineSink((line) => console.log(line));
    const stderr = createLineSink((line) => {
      console.error(line);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    });

    let slot = reuse ? await acquireShared() : await instantiateSlot(stdout, stderr);
    // Requests that were queued on the same instance resume first, and one of
    // them may have retired it. From this check to the end of `handle` nothing
    // awaits, so no other request can reach the instance until this one is done.
    while (slot.retired) slot = await acquireShared();
    const { instance } = slot;
    slot.stdout.target = stdout;
    slot.stderr.target = stderr;

    let result: ResponseResult | undefined;
    const incoming = new IncomingRequest({
      method: request.method,
      url,
      headers: request.headers,
      body,
    });
    const outparam = new ResponseOutparam((value) => {
      result = value;
    });

    try {
      instance.incomingHandler.handle(incoming, outparam);
    } catch (error) {
      // A trapped instance can't be trusted or even called again.
      retire(slot);
      stderr.end();
      const detail =
        stderrTail.length > 0
          ? stderrTail.join("\n")
          : error instanceof Error
            ? error.message
            : String(error);
      throw new PolyrouteError(
        "ROUTE_TRAPPED",
        `Route \`${route}\` trapped while handling ${request.method} ${url.pathname}:\n${detail}`,
        { cause: error },
      );
    } finally {
      stdout.end();
      stderr.end();
      slot.stdout.target = idle.stdout;
      slot.stderr.target = idle.stderr;
      slot.served++;
      if (!slot.retired && (!reuse || slot.served >= requestsPerInstance)) retire(slot);
    }

    if (result === undefined) {
      throw new PolyrouteError(
        "ROUTE_NO_RESPONSE",
        `Route \`${route}\` returned without sending a response. Respond (for example with \`responder.respond(...)\` in wstd) before the handler returns.`,
      );
    }
    if (result.tag === "err") {
      throw new PolyrouteError(
        "ROUTE_ERROR",
        `Route \`${route}\` answered with the wasi:http error \`${describeErrorCode(result.val)}\` instead of a response.`,
      );
    }
    return toWebResponse(route, request.method, result.val);
  };

  return { route, fetch };
}

function toWebResponse(route: string, method: string, response: OutgoingResponse): Response {
  const { status, headers, body } = readOutgoingResponse(response);

  if (status < 200) {
    throw new PolyrouteError(
      "ROUTE_INVALID_RESPONSE",
      `Route \`${route}\` responded with status ${status}. Informational (1xx) statuses can't be a final response.`,
    );
  }
  if (body !== undefined && !body.finished) {
    throw new PolyrouteError(
      "ROUTE_INVALID_RESPONSE",
      `Route \`${route}\` started a response body but never finished it. Call \`outgoing-body.finish\` (wstd does this when the body is dropped).`,
    );
  }

  const bytes = body?.bytes ?? new Uint8Array(0);
  const webHeaders = new Headers();
  for (const [name, value] of headers) webHeaders.append(name, latin1Decode(value));

  const declaredLength = webHeaders.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== bytes.length) {
    throw new PolyrouteError(
      "ROUTE_INVALID_RESPONSE",
      `Route \`${route}\` declared \`content-length: ${declaredLength}\` but wrote ${bytes.length} bytes.`,
    );
  }

  const hasNullBody = method === "HEAD" || NULL_BODY_STATUSES.has(status);
  return new Response(hasNullBody ? null : bytes, { status, headers: webHeaders });
}
