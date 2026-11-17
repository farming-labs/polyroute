import { PolyrouteError } from "../errors.js";

// Response checks and route errors that every runtime reports the same way.

/** How many of a request's last stderr lines a `ROUTE_TRAPPED` error carries. */
export const STDERR_TAIL_LINES = 20;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function trappedError(
  route: string,
  method: string,
  pathname: string,
  stderrTail: readonly string[],
  error: unknown,
): PolyrouteError {
  const detail =
    stderrTail.length > 0
      ? stderrTail.join("\n")
      : error instanceof Error
        ? error.message
        : String(error);
  return new PolyrouteError(
    "ROUTE_TRAPPED",
    `Route \`${route}\` trapped while handling ${method} ${pathname}:\n${detail}`,
    { cause: error },
  );
}

export function noResponseError(route: string): PolyrouteError {
  return new PolyrouteError(
    "ROUTE_NO_RESPONSE",
    `Route \`${route}\` returned without sending a response. Respond (for example with \`responder.respond(...)\` in wstd) before the handler returns.`,
  );
}

export function errorCodeError(route: string, code: string): PolyrouteError {
  return new PolyrouteError(
    "ROUTE_ERROR",
    `Route \`${route}\` answered with the wasi:http error \`${code}\` instead of a response.`,
  );
}

export function unfinishedBodyError(route: string): PolyrouteError {
  return new PolyrouteError(
    "ROUTE_INVALID_RESPONSE",
    `Route \`${route}\` started a response body but never finished it. Call \`outgoing-body.finish\` (wstd does this when the body is dropped).`,
  );
}

export function assertFinalStatus(route: string, status: number): void {
  if (status < 200) {
    throw new PolyrouteError(
      "ROUTE_INVALID_RESPONSE",
      `Route \`${route}\` responded with status ${status}. Informational (1xx) statuses can't be a final response.`,
    );
  }
}

/** Checks the declared length and leaves out the body where HTTP allows none. */
export function createResponse(
  route: string,
  method: string,
  status: number,
  headers: Headers,
  bytes: Uint8Array<ArrayBuffer>,
): Response {
  const declaredLength = headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== bytes.length) {
    throw new PolyrouteError(
      "ROUTE_INVALID_RESPONSE",
      `Route \`${route}\` declared \`content-length: ${declaredLength}\` but wrote ${bytes.length} bytes.`,
    );
  }

  const hasNullBody = method === "HEAD" || NULL_BODY_STATUSES.has(status);
  return new Response(hasNullBody ? null : bytes, { status, headers });
}
