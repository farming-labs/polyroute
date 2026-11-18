from polyroute import Request, Response


class Status(int):
    pass


_retained = None


def GET(request: Request) -> Response:
    case = request.query.get("case", "default")
    if case == "request":
        return Response.json({
            "method": request.method,
            "url": request.url,
            "path": request.path,
            "query": request.query,
            "headers": request.headers,
        })
    if case in ("short", "long", "length", "header-name", "header-value", "forbidden", "latin1", "binary", "empty"):
        headers = {
            "short": [("content-length", "2")],
            "long": [("content-length", "10")],
            "length": [("content-length", "wrong")],
            "header-name": [("bad name", "value")],
            "header-value": [("x-probe", "bad\nvalue")],
            "forbidden": [("connection", "close")],
            "latin1": [("x-probe", "café")],
        }.get(case, [])
        return Response(b"" if case == "empty" else bytes([0, 255, 128, 1]), headers=headers)
    status = {
        "created": 201,
        "float": 200.0,
        "negative": -1,
        "huge": 65536,
        "string": "200",
        "subclass": Status(200),
    }.get(case, 200)
    headers = None
    if case == "mapping":
        headers = {"X-Probe": "one", "Content-Type": "custom/test"}
    elif case == "cookies":
        headers = [("set-cookie", "a=1"), ("set-cookie", "b=2")]
    elif case == "generator":
        headers = (("x-" + str(index), str(index)) for index in range(2))
    if case in ("cycle", "object"):
        value = [] if case == "cycle" else object()
        if case == "cycle":
            value.append(value)
        try:
            Response.json(value)
        except (ValueError, TypeError):
            return Response.json({"recovered": True})
        raise AssertionError("JSON encoding accepted an invalid value")
    return Response.json({"text": "☃", "numbers": [1, 1.25, True, None]}, status, headers)


def POST(request: Request) -> Response:
    global _retained
    if request.query.get("case") == "retain":
        if _retained is None:
            _retained = request
        return Response(_retained.body, headers={"x-url": _retained.url})
    return Response(request.body, headers={"x-method": request.method})
