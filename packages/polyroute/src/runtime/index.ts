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
  type OutgoingResponse,
  type ResponseResult,
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

export interface WasiHttpHandlerOptions {
  /** The route's source path, used in error messages. */
  route: string;
  instantiate: InstantiateRoute;
  /** Core Wasm modules of the transpiled component, base64-encoded, keyed by file name. */
  coreModules: Readonly<Record<string, string>>;
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

function describeErrorCode(code: ErrorCode): string {
  return typeof code.val === "string" ? `${code.tag}: ${code.val}` : code.tag;
}

/**
 * Wraps a transpiled `wasi:http` component as a web-standard fetch handler.
 * Each request gets a fresh instance, so no state leaks between requests.
 */
export function createWasiHttpHandler(options: WasiHttpHandlerOptions): WasiHttpRoute {
  const { route } = options;
  const compiled = new Map<string, Promise<WebAssembly.Module>>();

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

    let instance: RouteInstance;
    try {
      instance = await options.instantiate(getCoreModule, createImports({ stdout, stderr }));
    } catch (error) {
      if (error instanceof PolyrouteError) throw error;
      throw new PolyrouteError(
        "ROUTE_INSTANTIATION_FAILED",
        `Route \`${route}\` couldn't be instantiated: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

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
      stderr.flush();
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
      stdout.flush();
      stderr.flush();
      instance._util?.stop();
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
