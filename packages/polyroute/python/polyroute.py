"""The Python side of polyroute.

A Python route is a module that defines a function per HTTP method:

    from polyroute import Request, Response

    def GET(request: Request) -> Response:
        return Response.json({"path": request.path})

polyroute builds the module into a WebAssembly component with componentize-py.
This file turns the component's `wasi:http` request into a `Request`, calls
the matching function, and writes the returned `Response` back.

A handler can be `async def`, to send requests with `polyroute_fetch.fetch`.
polyroute runs it on componentize-py's `poll_loop`.
"""

from __future__ import annotations

import inspect
import json as _json
from types import ModuleType
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple, Union
from urllib.parse import parse_qsl, urlsplit

from componentize_py_types import Err, Ok
from wit_world import exports
from wit_world.imports import streams, types

__all__ = ["Request", "Response", "create_handler"]

METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")

_METHOD_NAMES = {
    types.Method_Get: "GET",
    types.Method_Head: "HEAD",
    types.Method_Post: "POST",
    types.Method_Put: "PUT",
    types.Method_Delete: "DELETE",
    types.Method_Connect: "CONNECT",
    types.Method_Options: "OPTIONS",
    types.Method_Trace: "TRACE",
    types.Method_Patch: "PATCH",
}

# wasi:http streams accept at most 4096 bytes per blocking write.
_WRITE_CHUNK = 4096
_READ_CHUNK = 65536

Headers = Union[Mapping[str, str], Iterable[Tuple[str, str]]]


class Request:
    """An incoming request, with the body already read."""

    def __init__(self, method: str, url: str, headers: Dict[str, str], body: bytes) -> None:
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        parts = urlsplit(url)
        self.path = parts.path or "/"
        self.query: Dict[str, str] = dict(parse_qsl(parts.query, keep_blank_values=True))

    def text(self) -> str:
        return self.body.decode("utf-8")

    def json(self) -> Any:
        return _json.loads(self.body)


class Response:
    """A response to send. `body` may be `str` (sent as UTF-8), `bytes`, or `None`."""

    def __init__(
        self,
        body: Union[str, bytes, None] = None,
        status: int = 200,
        headers: Optional[Headers] = None,
    ) -> None:
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.body: bytes = body or b""
        self.status = status
        items = headers.items() if isinstance(headers, Mapping) else (headers or [])
        self.headers: List[Tuple[str, str]] = [(name, value) for name, value in items]

    @classmethod
    def json(cls, data: Any, status: int = 200, headers: Optional[Headers] = None) -> "Response":
        response = cls(_json.dumps(data, separators=(",", ":")), status, headers)
        if not any(name.lower() == "content-type" for name, _ in response.headers):
            response.headers.append(("content-type", "application/json"))
        return response


Handler = Callable[[Request], Any]


def create_handler(module: ModuleType) -> type:
    """Returns the `IncomingHandler` class componentize-py exports for a route module."""
    return _create_handler(module, _read_request, _send)


def _create_handler(
    module: ModuleType,
    read_request: Callable[[types.IncomingRequest], Request],
    send_response: Callable[[Response, types.ResponseOutparam], None],
) -> type:
    handlers: Dict[str, Handler] = {
        method: getattr(module, method)
        for method in METHODS
        if callable(getattr(module, method, None))
    }
    if not handlers:
        raise TypeError(
            f"{module.__name__}.py defines no handler. Define a function named after an "
            f"HTTP method, for example `def GET(request): ...`."
        )
    allowed = sorted(set(handlers) | ({"HEAD"} if "GET" in handlers else set()))
    run = (
        _event_loop(module.__name__)
        if any(inspect.iscoroutinefunction(handler) for handler in handlers.values())
        else None
    )

    class IncomingHandler(exports.IncomingHandler):
        def handle(
            self, request: types.IncomingRequest, response_out: types.ResponseOutparam
        ) -> None:
            incoming = read_request(request)
            handler = handlers.get(incoming.method)
            if handler is None and incoming.method == "HEAD":
                handler = handlers.get("GET")
            if handler is None:
                response = Response(status=405, headers={"allow": ", ".join(allowed)})
            else:
                response = handler(incoming)
                if run is not None and inspect.iscoroutine(response):
                    response = run(response)
                if not isinstance(response, Response):
                    raise TypeError(
                        f"{module.__name__}.{incoming.method} returned "
                        f"{type(response).__name__}, not a polyroute Response."
                    )
            send_response(response, response_out)

    return IncomingHandler


def _event_loop(module_name: str) -> Callable[[Any], Any]:
    """Returns a function that runs a coroutine to completion on componentize-py's `poll_loop`."""
    import asyncio

    try:
        from poll_loop import PollLoop
    except ImportError as error:
        raise ImportError(
            f"{module_name}.py has an async handler, which polyroute runs on componentize-py's "
            "poll_loop. poll_loop needs `wasi:http/outgoing-handler`, which polyroute adds only "
            "to a route whose files import `polyroute_fetch` or `poll_loop`. Import `fetch` "
            "from `polyroute_fetch`, or make the handler a plain `def`."
        ) from error

    def run(coroutine: Any) -> Any:
        loop = PollLoop()
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coroutine)

    return run


def _read_request(request: types.IncomingRequest) -> Request:
    method = request.method()
    name = method.value if isinstance(method, types.Method_Other) else _METHOD_NAMES[type(method)]

    scheme = request.scheme()
    if isinstance(scheme, types.Scheme_Https):
        prefix = "https"
    elif isinstance(scheme, types.Scheme_Other):
        prefix = scheme.value
    else:
        prefix = "http"
    url = f"{prefix}://{request.authority() or 'localhost'}{request.path_with_query() or '/'}"

    headers: Dict[str, str] = {}
    with request.headers() as fields:
        for key, value in fields.entries():
            text = value.decode("latin-1")
            headers[key] = f"{headers[key]}, {text}" if key in headers else text

    body = request.consume()
    chunks: List[bytes] = []
    with body.stream() as stream:
        while True:
            try:
                chunks.append(stream.blocking_read(_READ_CHUNK))
            except Err as error:
                if isinstance(error.value, streams.StreamError_Closed):
                    break
                raise
    with types.IncomingBody.finish(body):
        pass

    return Request(name, url, headers, b"".join(chunks))


def _send(response: Response, response_out: types.ResponseOutparam) -> None:
    fields = types.Fields.from_list(
        [(name.lower(), value.encode("latin-1")) for name, value in response.headers]
    )
    outgoing = types.OutgoingResponse(fields)
    outgoing.set_status_code(response.status)
    body = outgoing.body()
    types.ResponseOutparam.set(response_out, Ok(outgoing))
    with body.write() as stream:
        data = response.body
        for start in range(0, len(data), _WRITE_CHUNK):
            stream.blocking_write_and_flush(data[start : start + _WRITE_CHUNK])
    types.OutgoingBody.finish(body, None)
