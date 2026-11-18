# One server, four languages

A small Node server with a route in each of TypeScript, Rust, Go, and Python, all discovered by the same file router.

| Route                     | File                      | What it does                                      |
| ------------------------- | ------------------------- | ------------------------------------------------- |
| `GET /api/hello`          | `app/api/hello/route.ts`  | Returns a JSON greeting                           |
| `GET /api/primes?limit=N` | `app/api/primes/route.rs` | Counts primes below `N`                           |
| `POST /api/shout`         | `app/api/shout/route.rs`  | Returns the request body in uppercase             |
| `GET /api/relay`          | `app/api/relay/route.rs`  | Calls `/api/hello` over HTTP and wraps the answer |
| `GET /api/slug?text=...`  | `app/api/slug/route.go`   | Turns text into a URL slug                        |
| `POST /api/stats`         | `app/api/stats/route.py`  | Returns the count, mean, and median of numbers    |

The `primes-ts`, `slug-ts`, `stats-ts`, and `relay-ts` routes provide TypeScript counterparts for `node scripts/bench.mjs --matched`. The benchmark sends the same payload to each pair and checks the same response bytes. The slug comparison uses ASCII text, and the statistics comparison uses `[1, 2, 3, 4]`; these fixtures do not claim identical Unicode or floating-point behavior for arbitrary inputs across languages.

Building it needs Rust with the `wasm32-wasip2` target, Go 1.27.1 or newer, and componentize-py (see the [quick start](../../README.md#quick-start)). Running the built server needs only Node.

Run it from the repository root after `pnpm install`:

```bash
pnpm --filter @farming-labs/polyroute build
```

```bash
pnpm --filter polyroute-example-polyglot dev
```

```bash
curl -X POST http://127.0.0.1:3000/api/stats -d '[3, 1, 4, 1, 5]'
```

Build and run the production server, which is plain JavaScript:

```bash
pnpm --filter polyroute-example-polyglot build
```

```bash
pnpm --filter polyroute-example-polyglot start
```

`src/app.ts` is the router, `src/server.ts` the production entry, and `dev.js` the dev server. The Go route has its own `go.mod`, because componentize-go builds from the module root.
