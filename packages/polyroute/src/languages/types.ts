import type { Runtime } from "../plugin.js";

export interface RouteBuildInput {
  /** Absolute path of the route file. */
  routeFile: string;
  /** Root-relative path of the route, used in messages. */
  label: string;
  /** polyroute's directory inside Vite's cache directory. */
  cacheDir: string;
  /** Runtime the built component must link against. Development uses jco. */
  runtime?: Runtime;
}

export interface RouteBuildResult {
  /** A Wasm component that exports `wasi:http/incoming-handler@0.2`. */
  wasm: Uint8Array;
  /** Local source files the build read, for the dev server to watch. */
  sources: string[];
}

export interface Language {
  /** Shown in messages, for example "Rust". */
  readonly name: string;
  /** File extensions this language builds, with the leading dot. */
  readonly extensions: readonly string[];
  /** How to export the handler in this language, appended to `MISSING_HANDLER` errors. */
  readonly handlerHint: string;
  /**
   * Requests one reused instance serves before the runtime replaces it. Set it
   * for a language whose bindings leak memory on every request.
   */
  readonly requestsPerInstance?: number;
  /** Returns false for a file with a matching extension that polyroute should leave to Vite. */
  accepts?(routeFile: string): Promise<boolean>;
  build(input: RouteBuildInput): Promise<RouteBuildResult>;
}
