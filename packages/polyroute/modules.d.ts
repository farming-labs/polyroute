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
