/**
 * Interfaces that language runtimes link whether or not a route uses them:
 * CPython and TinyGo's libc import the filesystem and sockets at startup. They
 * are provided with nothing behind them. There are no preopened directories,
 * so opening a file fails, and every socket call returns `access-denied`.
 */

type NetworkErrorCode = "access-denied";

class Descriptor {}
class DirectoryEntryStream {}
class Network {}
class TcpSocket {}
class UdpSocket {}
class IncomingDatagramStream {}
class OutgoingDatagramStream {}
class ResolveAddressStream {}

// jco turns a thrown non-Error value into the `err` case of the WIT result.
function deny(): never {
  throw "access-denied" satisfies NetworkErrorCode;
}

export function createDeniedImports() {
  return {
    "wasi:filesystem/preopens": {
      getDirectories: (): Array<[Descriptor, string]> => [],
    },
    "wasi:filesystem/types": {
      Descriptor,
      DirectoryEntryStream,
      filesystemErrorCode: (): undefined => undefined,
    },
    "wasi:sockets/network": {
      Network,
      networkErrorCode: (): undefined => undefined,
    },
    "wasi:sockets/instance-network": {
      instanceNetwork: () => new Network(),
    },
    "wasi:sockets/tcp": { TcpSocket },
    "wasi:sockets/tcp-create-socket": { createTcpSocket: deny },
    "wasi:sockets/udp": { UdpSocket, IncomingDatagramStream, OutgoingDatagramStream },
    "wasi:sockets/udp-create-socket": { createUdpSocket: deny },
    "wasi:sockets/ip-name-lookup": { ResolveAddressStream, resolveAddresses: deny },
  };
}
