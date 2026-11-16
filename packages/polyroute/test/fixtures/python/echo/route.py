from polyroute import Request, Response

from greeting import greet


def GET(request: Request) -> Response:
    return Response(
        f"method=GET\npath={request.path}\nname={request.query.get('name', 'none')}\n"
        f"greeting={request.headers.get('x-greeting', 'none')}\n{greet()}\n",
        headers={"content-type": "text/plain; charset=utf-8", "x-served-by": "python"},
    )


def POST(request: Request) -> Response:
    payload = request.json()
    return Response.json({"received": payload, "length": len(request.body)}, status=201)
