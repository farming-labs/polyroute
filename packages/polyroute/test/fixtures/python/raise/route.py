from polyroute import Request, Response


def GET(request: Request) -> Response:
    raise RuntimeError("fixture route raised on purpose")
