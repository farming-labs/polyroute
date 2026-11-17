from polyroute import Request, Response


# An async handler in a route that never imports `polyroute_fetch`, which
# polyroute builds without `wasi:http/outgoing-handler`.
async def GET(request: Request) -> Response:
    return Response("unreachable")
