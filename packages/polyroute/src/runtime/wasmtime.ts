import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PolyrouteError } from "../errors.js";
import type { FetchHandler, InstanceMode, WasiHttpRoute } from "./index.js";
import { createOutboundPolicy, type OutboundOptions } from "./outbound.js";
import { createNativeOutbound } from "./wasmtime-outbound.js";
import {
  STDERR_TAIL_LINES,
  assertFinalStatus,
  createResponse,
  errorCodeError,
  noResponseError,
  trappedError,
  unfinishedBodyError,
} from "./response.js";

// The parts of `@farming-labs/polyroute-wasmtime` this runtime calls. The
// build copies the addon next to the bundle, so nothing imports the package.
interface HandleResult {
  outcome:
    | "ok"
    | "instantiation-failed"
    | "invalid-request"
    | "trap"
    | "no-response"
    | "error-code"
    | "unfinished-body";
  status: number;
  headers: string[];
  body: Uint8Array<ArrayBuffer>;
  message?: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface AddonRoute {
  handle(method: string, url: string, headers: string[], body: Uint8Array): HandleResult;
  handleAsync(
    request: { method: string; url: string; headers: string[]; body: Uint8Array },
    outbound: ReturnType<typeof createNativeOutbound>,
  ): Promise<HandleResult>;
}

interface Addon {
  Route: new (
    path: string,
    options: { perRequest: boolean; requestsPerInstance: number },
  ) => AddonRoute;
}

export interface WasmtimeHandlerOptions {
  /** The route's source path, used in error messages. */
  route: string;
  /** The Rust target triple the build compiled the route for. */
  target: string;
  /** The addon the build copied next to the bundle. */
  addon: URL;
  /** The route's machine code, which the build compiled with that addon. */
  component: URL;
  /** Defaults to `"reuse"`. */
  instances?: InstanceMode;
  /** Replaces a reused instance after this many requests. Defaults to no limit. */
  requestsPerInstance?: number;
  /** Only set for components that import outbound HTTP. */
  outbound?: OutboundOptions;
}

const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(options: WasmtimeHandlerOptions, detail: string, cause: unknown) {
  return new PolyrouteError(
    "RUNTIME_UNAVAILABLE",
    `Route \`${options.route}\` was built with \`experimental.runtime: "wasmtime"\` for \`${options.target}\`, and this server (${process.platform} ${process.arch}) can't run it: ${detail} Deploy the \`polyroute\` directory that \`vite build\` writes next to the server bundle, to a server with the same target, or build with the default runtime.`,
    { cause },
  );
}

/** Logs output a request wrote, one line at a time, and returns the lines. */
function logLines(bytes: Uint8Array, log: (line: string) => void): string[] {
  if (bytes.length === 0) return [];
  const lines = decoder.decode(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) log(line);
  return lines;
}

/**
 * Serves a route from machine code that `vite build` compiled with wasmtime,
 * through the Node-API addon it copied next to the bundle. Outbound routes run
 * on native workers so the JavaScript HTTP host can make progress while they wait.
 */
export function createWasmtimeHandler(options: WasmtimeHandlerOptions): WasiHttpRoute {
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
  const perRequest = (options.instances ?? "reuse") === "per-request";
  const policy =
    options.outbound === undefined ? undefined : createOutboundPolicy(options.outbound);
  let loaded: AddonRoute | undefined;

  // Loaded on the first request, like core modules, so a server whose files
  // are missing still starts and serves its other routes. A failed load isn't
  // kept, so the next request tries again.
  const load = (): AddonRoute => {
    if (loaded !== undefined) return loaded;
    let addon: Addon;
    try {
      addon = createRequire(import.meta.url)(fileURLToPath(options.addon)) as Addon;
    } catch (error) {
      throw unavailable(options, `the addon didn't load (${describe(error)}).`, error);
    }
    try {
      loaded = new addon.Route(fileURLToPath(options.component), {
        perRequest,
        requestsPerInstance: requestsPerInstance === Infinity ? 0 : requestsPerInstance,
      });
    } catch (error) {
      throw unavailable(options, `its machine code didn't load (${describe(error)}).`, error);
    }
    return loaded;
  };

  const fetch: FetchHandler = async (request) => {
    const handler = load();
    const body = request.body === null ? EMPTY : new Uint8Array(await request.arrayBuffer());
    const headers: string[] = [];
    request.headers.forEach((value, name) => headers.push(name, value));

    let result: HandleResult;
    if (policy === undefined) {
      result = handler.handle(request.method, request.url, headers, body);
    } else {
      const controller = new AbortController();
      try {
        result = await handler.handleAsync(
          { method: request.method, url: request.url, headers, body },
          createNativeOutbound(policy, controller.signal),
        );
      } finally {
        controller.abort(new Error("The route finished handling the request."));
      }
    }
    logLines(result.stdout, (line) => console.log(line));
    const stderr = logLines(result.stderr, (line) => console.error(line));

    switch (result.outcome) {
      case "ok":
        break;
      case "trap": {
        const pathname = new URL(request.url).pathname;
        const tail = stderr.slice(-STDERR_TAIL_LINES);
        throw trappedError(route, request.method, pathname, tail, new Error(result.message ?? ""));
      }
      case "instantiation-failed":
        throw new PolyrouteError(
          "ROUTE_INSTANTIATION_FAILED",
          `Route \`${route}\` couldn't be instantiated: ${result.message ?? ""}`,
        );
      case "no-response":
        throw noResponseError(route);
      case "error-code":
        throw errorCodeError(route, result.message ?? "");
      case "unfinished-body":
        throw unfinishedBodyError(route);
      case "invalid-request":
        throw new TypeError(
          `polyroute couldn't pass ${request.method} ${request.url} to route \`${route}\`: ${result.message ?? ""}`,
        );
    }

    assertFinalStatus(route, result.status);
    const responseHeaders = new Headers();
    for (let index = 0; index < result.headers.length; index += 2) {
      responseHeaders.append(result.headers[index]!, result.headers[index + 1]!);
    }
    return createResponse(route, request.method, result.status, responseHeaders, result.body);
  };

  return { route, fetch };
}
