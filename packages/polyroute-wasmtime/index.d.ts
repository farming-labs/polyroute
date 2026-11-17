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

export declare class Route {
  /** Maps a `.cwasm` that `precompile` from this same addon wrote. */
  constructor(path: string, options: RouteOptions);
  /** Serves one request, synchronously, on the calling thread. */
  handle(method: string, url: string, headers: string[], body: Buffer): HandleResult;
}

export interface Addon {
  info(): AddonInfo;
  precompile(component: Uint8Array): Buffer;
  Route: typeof Route;
}

export declare const addonPath: string;
export declare function loadAddon(): Addon;
