# Farm route latency on Node and a direct WASI HTTP host

For the same prime-counting algorithm under Farm, Rust through V8 reduced warm HTTP p95 by
47% at one connection and 40% at ten. At ten connections the light Rust route took 32% longer
at p95 than its TypeScript twin. These measurements cover one public endpoint on one Mac.

The [production probe](../../probes/farm/README.md) builds two outputs from the same component.
Farm 0.1.87's Node server calls it through Polyroute's default Fetch adapter. Wasmtime serves
the raw component directly. A bare Node server runs the TypeScript handler as a control for
the direct host, so a comparison between the two direct hosts includes neither Farm router.

## Warm HTTP latency

Median of ten round-level measurements, in milliseconds. Every response had the expected status,
content type, and bytes. The heavy input counts primes below 100,000. The light input uses the
same route with a limit of 2.

| Input | Connections | Farm TypeScript p50 / p95 | Farm Rust p50 / p95 | Bare Node TypeScript p50 / p95 | Direct WASI Rust p50 / p95 |
| ----- | ----------: | ------------------------: | ------------------: | -----------------------------: | -------------------------: |
| Heavy |           1 |               4.69 / 6.22 |         2.56 / 3.32 |                    4.35 / 5.58 |                3.05 / 3.83 |
| Heavy |          10 |             52.21 / 57.92 |       23.92 / 35.00 |                  34.92 / 77.41 |              29.11 / 34.21 |
| Light |           1 |               0.27 / 0.82 |         0.31 / 0.52 |                    0.08 / 0.12 |                0.08 / 0.11 |
| Light |          10 |               1.16 / 3.08 |         1.58 / 4.06 |                    0.36 / 0.72 |                0.38 / 0.53 |

Farm Rust won 9/10 paired heavy p95 comparisons at each connection count. An identical second
Farm TypeScript server measured 6.32 and 53.02 ms p95, differences of 1.6% and 8.5% from the
first. Direct WASI Rust won 10/10 paired heavy p95 comparisons against bare Node at each
connection count. Those two hosts also differ in their HTTP implementations. There was no
separate bare-Node A/A series. The heavy gains cannot be attributed solely to compiling to Wasm.

At ten connections the heavy route served 399 requests/s on Farm Rust, 188 on Farm TypeScript,
329 on direct WASI Rust, and 224 on bare Node TypeScript. On the light route Farm Rust lost 9/10
paired p95 comparisons at ten connections. The light Farm TypeScript A/A differed by 17% at ten
connections and 22% at one. Small light-route differences are inconclusive.

## First verified response

Twenty fresh processes per mode. Milliseconds include process startup and the first complete
correct response for a limit of 10. Node's disk compile cache was disabled. Wasmtime used its
installed CLI defaults apart from the probe's explicit serve options. OS file caches were warm.

| Host                 | Median (ms) | p95 (ms) |
| -------------------- | ----------: | -------: |
| Farm TypeScript      |        90.7 |    125.4 |
| Farm TypeScript A/A  |        87.5 |    125.6 |
| Farm Rust through V8 |        96.2 |    153.3 |
| Bare Node TypeScript |        61.0 |     69.8 |
| Direct WASI Rust     |        20.2 |     36.3 |

## Reproduce

Use the [build and measurement commands](../../probes/farm/README.md#measure). This run used
Polyroute `7655ad32c343e60b51eef76c65b948bc0184eaa1`, Farm 0.1.87, Node 24.21.0, Rust
1.99.1, wstd 0.5.6, and Wasmtime 50.0.1 on an eight-core Apple M1 with macOS 26.2.
The component was 260,948 bytes. Both build inputs had SHA-256
`61d364e39c8aec052b4ad664a3e259e0927eb2b9e0541189c936155d8e4fecad`.

Each of the ten warm rounds used 500 ms of warmup and 1.5 s of measurement per case. Backend
order rotated and reversed. The local client used one or ten closed-loop connections.
The WASI host admitted one guest request at a time and could reuse an instance up to 128 times.
All 1,297,671 measured warm responses, 417,945 warmups, and 100 first-response samples passed.
No samples were discarded. One-minute system load was 4.04 at the start and 4.70 at the end.
The original local report has SHA-256
`29ecf8f188e23750988d235fe05e7013f2a6b2e98f1742830d0186e2f41c9d31`.

The stock Farm CLI currently needs a staging step for Rust route discovery. Farm's final Node
output also needs Polyroute's emitted Wasm code assets included. The probe handles both in its
build directory. Direct WASI hosting requires the host to route the public endpoint and apply any
required middleware there. No vendor deployment, billing measurement, or other language
was tested here.
