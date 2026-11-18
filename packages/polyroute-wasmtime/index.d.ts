export interface AddonInfo {
  /** The Rust target triple the addon was built for, such as `aarch64-apple-darwin`. */
  target: string;
  /** The exact wasmtime version a `.cwasm` has to come from. */
  wasmtime: string;
}

export interface RouteOptions {
  /** Gives every request a fresh instance instead of reusing one. */
  perRequest: boolean;
  /** Replaces a reused instance after this many requests. `0` means no limit. */
  requestsPerInstance: number;
}

export type HandleOutcome =
  | "ok"
  | "instantiation-failed"
  | "invalid-request"
  | "trap"
  | "no-response"
  | "error-code"
  | "unfinished-body";

export interface HandleResult {
  outcome: HandleOutcome;
  status: number;
  /** Names and values, alternating. Values are Latin-1, like `Headers`. */
  headers: string[];
  body: Buffer;
  message?: string | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface OutboundRequest {
  method: string;
  url: string;
  headers: string[];
  body: Buffer;
  /** Decimal strings preserve WASI's u64 nanoseconds. */
  connectTimeoutNs?: string | null;
  firstByteTimeoutNs?: string | null;
  betweenBytesTimeoutNs?: string | null;
}

export interface OutboundResponse {
  status: number;
  headers: string[];
  body: Buffer;
  error?: string | null;
  message?: string | null;
}

export declare class Route {
  /** Maps a `.cwasm` from the matching build-time compiler. */
  constructor(path: string, options: RouteOptions);
  /** Serves one request, synchronously, on the calling thread. */
  handle(method: string, url: string, headers: string[], body: Buffer): HandleResult;
  /** Runs an outbound route on a native worker, with at most 32 calls in flight. */
  handleAsync(
    request: { method: string; url: string; headers: string[]; body: Buffer },
    outbound: (request: OutboundRequest) => Promise<OutboundResponse>,
  ): Promise<HandleResult>;
}

export interface RuntimeAddon {
  info(): AddonInfo;
  Route: typeof Route;
}

export interface Addon extends RuntimeAddon {
  precompile(component: Uint8Array): Buffer;
}

/** The compiler-free binary copied into deployed servers. */
export declare const addonPath: string;
/** Loads the compiler addon used during builds. */
export declare function loadAddon(): Addon;
