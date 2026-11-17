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
  type OutboundContext,
  type OutgoingResponse,
  type ResponseResult,
  type StreamSink,
} from "./host.js";
import { createOutboundPolicy, type OutboundOptions, type OutboundPolicy } from "./outbound.js";

export { PolyrouteError, type PolyrouteErrorCode } from "../errors.js";
export type { OutboundOptions } from "./outbound.js";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface RouteInstance {
  incomingHandler: {
    /** Returns a promise in a route transpiled with JSPI. */
    handle(request: IncomingRequest, responseOut: ResponseOutparam): Promise<void> | undefined;
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
  /** Core Wasm modules of the transpiled component, base64-encoded, keyed by file name. */
  coreModules: Readonly<Record<string, string>>;
  /** Defaults to `"reuse"`. */
  instances?: InstanceMode;
  /**
   * Replaces a reused instance after it has served this many requests, for
   * guests whose memory grows with every request. Defaults to no limit.
   */
  requestsPerInstance?: number;
  /**
   * Hosts the route may send HTTP requests to. Set only for a route that
   * imports `wasi:http/outgoing-handler` and was transpiled with JSPI, whose
   * `handle` can wait for a response without blocking the event loop.
   */
  outbound?: OutboundOptions;
}

export interface WasiHttpRoute {
  readonly route: string;
  readonly fetch: FetchHandler;
}

const STDERR_TAIL_LINES = 20;
// Built once: `abort()` without a reason builds a DOMException on every
// request, which costs several times more than the rest of the abort.
const ROUTE_ANSWERED = new DOMException("The route answered its request.", "AbortError");
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * A route that waits for outbound responses serves concurrent requests with
 * one reused instance each, up to this many. Further requests wait for one.
 * A route that never waits only ever needs one.
 */
export const MAX_INSTANCES_PER_ROUTE = 32;

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
  outbound: OutboundContext | undefined;
  served: number;
  retired: boolean;
}

function hasJspi(): boolean {
  return typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";
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
  const policy: OutboundPolicy | undefined =
    options.outbound === undefined ? undefined : createOutboundPolicy(options.outbound);
  const maxInstances = policy === undefined ? 1 : MAX_INSTANCES_PER_ROUTE;
  const compiled = new Map<string, Promise<WebAssembly.Module>>();
  // Output written outside a request, such as while a reused instance starts.
  const idle = {
    stdout: createLineSink((line) => console.log(line)),
    stderr: createLineSink((line) => console.error(line)),
  };

  const getCoreModule = (path: string): Promise<WebAssembly.Module> => {
    let module = compiled.get(path);
    if (module === undefined) {
      const encoded = options.coreModules[path];
      if (encoded === undefined) {
        return Promise.reject(
          new PolyrouteError(
            "ROUTE_INSTANTIATION_FAILED",
            `Route \`${route}\` asked for the core module \`${path}\`, which wasn't bundled. Rebuild the app so the route is transpiled again.`,
          ),
        );
      }
      module = WebAssembly.compile(decodeBase64(encoded));
      compiled.set(path, module);
    }
    return module;
  };

  const instantiateSlot = async (stdout: LineSink, stderr: LineSink): Promise<Slot> => {
    if (policy !== undefined && !hasJspi()) {
      throw new PolyrouteError(
        "UNSUPPORTED_RUNTIME",
        `Route \`${route}\` sends HTTP requests, which needs WebAssembly JavaScript Promise Integration (\`WebAssembly.Suspending\`). This JavaScript runtime doesn't have it. Run the server on Node 24 or later.`,
      );
    }
    const relays = { stdout: createRelay(stdout), stderr: createRelay(stderr) };
    const outbound = policy === undefined ? undefined : { policy, signal: undefined };
    try {
      const instance = await options.instantiate(
        getCoreModule,
        createImports({ ...relays, outbound }),
      );
      return { instance, ...relays, outbound, served: 0, retired: false };
    } catch (error) {
      if (error instanceof PolyrouteError) throw error;
      throw new PolyrouteError(
        "ROUTE_INSTANTIATION_FAILED",
        `Route \`${route}\` couldn't be instantiated: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  // Reused instances that aren't serving a request, most recently used last.
  const idleSlots: Slot[] = [];
  // Reused instances that are starting, idle, or serving a request.
  let liveSlots = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<Slot> => {
    for (;;) {
      const slot = idleSlots.pop();
      if (slot !== undefined) return slot;
      if (liveSlots < maxInstances) {
        liveSlots++;
        try {
          const started = await instantiateSlot(idle.stdout, idle.stderr);
          idle.stdout.end();
          idle.stderr.end();
          return started;
        } catch (error) {
          // A failed start isn't kept, so the next request tries again.
          liveSlots--;
          waiting.shift()?.();
          throw error;
        }
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };

  const retire = (slot: Slot): void => {
    slot.retired = true;
    slot.instance._util?.stop();
  };

  const release = (slot: Slot): void => {
    if (slot.retired) liveSlots--;
    else idleSlots.push(slot);
    waiting.shift()?.();
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

    // An acquired instance serves only this request until it's released.
    const slot = reuse ? await acquire() : await instantiateSlot(stdout, stderr);
    const { instance } = slot;
    slot.stdout.target = stdout;
    slot.stderr.target = stderr;
    // Requests the route sends are cancelled once it has answered this one.
    const controller = slot.outbound === undefined ? undefined : new AbortController();
    if (slot.outbound !== undefined) slot.outbound.signal = controller!.signal;

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
      const pending = instance.incomingHandler.handle(incoming, outparam);
      if (pending !== undefined) await pending;
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
      controller?.abort(ROUTE_ANSWERED);
      if (slot.outbound !== undefined) slot.outbound.signal = undefined;
      stdout.end();
      stderr.end();
      slot.stdout.target = idle.stdout;
      slot.stderr.target = idle.stderr;
      slot.served++;
      if (!slot.retired && (!reuse || slot.served >= requestsPerInstance)) retire(slot);
      if (reuse) release(slot);
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
