// Route files polyroute builds into fetch handler modules. Every language gets
// the same exports, and the route itself decides which methods it accepts.
// TypeScript can't share one declaration across patterns, so each is repeated.

declare module "*.rs" {
  import type { FetchHandler, WasiHttpRoute } from "@farming-labs/polyroute/runtime";

  const route: WasiHttpRoute;
  export default route;
  export const fetch: FetchHandler;
  export const GET: FetchHandler;
  export const HEAD: FetchHandler;
  export const POST: FetchHandler;
  export const PUT: FetchHandler;
  export const PATCH: FetchHandler;
  export const DELETE: FetchHandler;
  export const OPTIONS: FetchHandler;
}

declare module "*.go" {
  import type { FetchHandler, WasiHttpRoute } from "@farming-labs/polyroute/runtime";

  const route: WasiHttpRoute;
  export default route;
  export const fetch: FetchHandler;
  export const GET: FetchHandler;
  export const HEAD: FetchHandler;
  export const POST: FetchHandler;
  export const PUT: FetchHandler;
  export const PATCH: FetchHandler;
  export const DELETE: FetchHandler;
  export const OPTIONS: FetchHandler;
}

declare module "*.py" {
  import type { FetchHandler, WasiHttpRoute } from "@farming-labs/polyroute/runtime";

  const route: WasiHttpRoute;
  export default route;
  export const fetch: FetchHandler;
  export const GET: FetchHandler;
  export const HEAD: FetchHandler;
  export const POST: FetchHandler;
  export const PUT: FetchHandler;
  export const PATCH: FetchHandler;
  export const DELETE: FetchHandler;
  export const OPTIONS: FetchHandler;
}

declare module "*.wasm" {
  import type { FetchHandler, WasiHttpRoute } from "@farming-labs/polyroute/runtime";

  const route: WasiHttpRoute;
  export default route;
  export const fetch: FetchHandler;
  export const GET: FetchHandler;
  export const HEAD: FetchHandler;
  export const POST: FetchHandler;
  export const PUT: FetchHandler;
  export const PATCH: FetchHandler;
  export const DELETE: FetchHandler;
  export const OPTIONS: FetchHandler;
}
