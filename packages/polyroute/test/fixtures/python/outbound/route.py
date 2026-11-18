import asyncio

from componentize_py_types import Err
from polyroute import Request, Response
from polyroute_fetch import fetch


# Sends the request it receives to the URL in its `x-upstream` header, so tests
# can point it at a local server, and answers with what came back. With
# `x-fan-out: n`, it sends n copies at once and answers with every body.
async def GET(request: Request) -> Response:
    target = request.headers.get("x-upstream", "")
    copies = int(request.headers.get("x-fan-out", "1"))
    sent = [
        fetch(target, method=request.method, headers={"x-sent-by": "python"}, body=request.body)
        for _ in range(copies)
    ]
    try:
        upstreams = await asyncio.gather(*sent)
    except Err as error:
        return Response(repr(error.value), status=502)
    headers = {"x-upstream-status": str(upstreams[0].status)}
    for name, value in upstreams[0].headers:
        if name == "content-type":
            headers[name] = value
    return Response(b"\n".join(upstream.body for upstream in upstreams), headers=headers)


POST = GET
