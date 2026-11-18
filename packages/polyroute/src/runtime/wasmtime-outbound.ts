import type { ErrorCode } from "./host.js";
import { sendOutbound, type OutboundPolicy } from "./outbound.js";

export interface NativeOutboundRequest {
  method: string;
  url: string;
  headers: string[];
  body: Uint8Array<ArrayBuffer>;
  connectTimeoutNs?: string | null;
  firstByteTimeoutNs?: string | null;
  betweenBytesTimeoutNs?: string | null;
}

export interface NativeOutboundResponse {
  status: number;
  headers: string[];
  body: Buffer;
  error?: string;
  message?: string;
}

function failure(code: ErrorCode): NativeOutboundResponse {
  return {
    status: 0,
    headers: [],
    body: Buffer.alloc(0),
    error: code.tag,
    ...(typeof code.val === "string" ? { message: code.val } : {}),
  };
}

/** Adapts owned Node-API data to the same outbound host used by jco. */
export function createNativeOutbound(policy: OutboundPolicy, signal: AbortSignal) {
  return async (request: NativeOutboundRequest): Promise<NativeOutboundResponse> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return failure({ tag: "HTTP-request-URI-invalid" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failure({ tag: "HTTP-request-URI-invalid" });
    }
    if (!policy.allows(url)) return failure({ tag: "HTTP-request-denied" });
    const headers: Array<[string, string]> = [];
    for (let index = 0; index < request.headers.length; index += 2) {
      headers.push([request.headers[index]!, request.headers[index + 1]!]);
    }
    const nanos = (value: string | null | undefined) => (value == null ? undefined : BigInt(value));
    const response = await sendOutbound(
      {
        method: request.method,
        url,
        headers,
        body: request.body,
        connectTimeout: nanos(request.connectTimeoutNs),
        firstByteTimeout: nanos(request.firstByteTimeoutNs),
        betweenBytesTimeout: nanos(request.betweenBytesTimeoutNs),
      },
      signal,
    );
    if (response.tag === "err") return failure(response.val);
    return {
      status: response.val.status,
      headers: response.val.headers.flat(),
      body: Buffer.from(response.val.body),
    };
  };
}
