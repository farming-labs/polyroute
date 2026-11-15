type Handler = (request: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<string, Handler>>;

// Routes in every language are discovered the same way. polyroute turns each
// non-TypeScript route into a module with GET, POST, and the other method
// exports, and the route itself decides which methods it accepts.
const modules = import.meta.glob<RouteModule>("../app/**/route.{ts,rs,py}", { eager: true });

const routes = Object.entries(modules).map(([file, module]) => ({
  pathname: file.replace(/^\.\.\/app/, "").replace(/\/route\.(ts|rs|py)$/, "") || "/",
  module,
}));

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = routes.find((candidate) => candidate.pathname === pathname);
  if (route === undefined) {
    return Response.json({ error: `No route matches ${pathname}.` }, { status: 404 });
  }
  const handler = route.module[request.method];
  if (handler === undefined) {
    return Response.json(
      { error: `${pathname} doesn't accept ${request.method}.` },
      { status: 405 },
    );
  }
  return handler(request);
}
