export type PolyrouteErrorCode =
  /** An option passed to `polyroute()` has a value it doesn't accept. */
  | "INVALID_OPTIONS"
  /** `cargo` isn't installed or isn't on `PATH`. */
  | "TOOLCHAIN_MISSING"
  /** The `wasm32-wasip2` Rust target isn't installed. */
  | "TARGET_MISSING"
  /** `cargo build` failed, usually because the route doesn't compile. */
  | "BUILD_FAILED"
  /** A `.rs` route was imported from browser code. */
  | "CLIENT_IMPORT"
  /** The component imports an interface the embedded runtime doesn't provide. */
  | "UNSUPPORTED_IMPORT"
  /** The component doesn't export `wasi:http/incoming-handler`. */
  | "MISSING_HANDLER"
  /** The compiled route couldn't be instantiated. */
  | "ROUTE_INSTANTIATION_FAILED"
  /** The route trapped, for example because the Rust code panicked. */
  | "ROUTE_TRAPPED"
  /** The route returned without setting a response. */
  | "ROUTE_NO_RESPONSE"
  /** The route responded with a `wasi:http` error code instead of a response. */
  | "ROUTE_ERROR"
  /** The route produced a response that can't be sent as-is. */
  | "ROUTE_INVALID_RESPONSE";

export class PolyrouteError extends Error {
  readonly code: PolyrouteErrorCode;

  constructor(code: PolyrouteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolyrouteError";
    this.code = code;
  }
}
