# Rust routes next to TypeScript routes

A small Node server with one TypeScript route and two Rust routes, discovered by the same file router.

| Route                     | File                      | What it does                          |
| ------------------------- | ------------------------- | ------------------------------------- |
| `GET /api/hello`          | `app/api/hello/route.ts`  | Returns a JSON greeting               |
| `GET /api/primes?limit=N` | `app/api/primes/route.rs` | Counts primes below `N`               |
| `POST /api/shout`         | `app/api/shout/route.rs`  | Returns the request body in uppercase |

Run it from the repository root after `pnpm install` (you need `rustup target add wasm32-wasip2`):

```bash
pnpm --filter @farming-labs/polyroute build
```

```bash
pnpm --filter polyroute-example-rust-route dev
```

```bash
curl "http://127.0.0.1:3000/api/primes?limit=1000"
```

Build and run the production server, which is plain JavaScript:

```bash
pnpm --filter polyroute-example-rust-route build
```

```bash
pnpm --filter polyroute-example-rust-route start
```

`src/app.ts` is the router, `src/server.ts` the production entry, and `dev.js` the dev server.
