/**
 * Every WASI interface the embedded runtime provides, without versions.
 * A route may import any of these at `0.2.x`; anything else fails the build.
 * The filesystem and sockets are linked but deny everything (see
 * `runtime/denied.ts`).
 */
export const SUPPORTED_INTERFACES = [
  "wasi:cli/environment",
  "wasi:cli/exit",
  "wasi:cli/stdin",
  "wasi:cli/stdout",
  "wasi:cli/stderr",
  "wasi:cli/terminal-input",
  "wasi:cli/terminal-output",
  "wasi:cli/terminal-stdin",
  "wasi:cli/terminal-stdout",
  "wasi:cli/terminal-stderr",
  "wasi:clocks/monotonic-clock",
  "wasi:clocks/wall-clock",
  "wasi:io/error",
  "wasi:io/poll",
  "wasi:io/streams",
  "wasi:random/random",
  "wasi:random/insecure",
  "wasi:random/insecure-seed",
  "wasi:http/types",
  "wasi:filesystem/types",
  "wasi:filesystem/preopens",
  "wasi:sockets/network",
  "wasi:sockets/instance-network",
  "wasi:sockets/tcp",
  "wasi:sockets/tcp-create-socket",
  "wasi:sockets/udp",
  "wasi:sockets/udp-create-socket",
  "wasi:sockets/ip-name-lookup",
] as const;

export const HTTP_HANDLER_INTERFACE = "wasi:http/incoming-handler";

export interface InterfaceName {
  name: string;
  version: string | undefined;
}

export function parseInterfaceName(qualified: string): InterfaceName {
  const at = qualified.lastIndexOf("@");
  if (at === -1) return { name: qualified, version: undefined };
  return { name: qualified.slice(0, at), version: qualified.slice(at + 1) };
}

export function isSupportedVersion(version: string | undefined): boolean {
  return version === undefined || version.startsWith("0.2.");
}
