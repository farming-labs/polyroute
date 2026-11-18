"""Sends HTTP requests from a polyroute route.

    from polyroute import Request, Response
    from polyroute_fetch import fetch

    async def GET(request: Request) -> Response:
        upstream = await fetch("https://api.example.com/items")
        return Response(upstream.body, status=upstream.status)

`fetch` sends the request through `wasi:http/outgoing-handler` with
componentize-py's `poll_loop`, so the handler must be `async def`. Requests go
only to hosts listed in `polyroute({ outbound: { allow: [...] } })`. A request
that fails, including one to a host that isn't allowed, raises
`componentize_py_types.Err` with the `wasi:http` error code as its `value`, such
as `ErrorCode_HttpRequestDenied`.
"""

from __future__ import annotations

import asyncio
from typing import List, Mapping, Optional, Tuple, Union
from urllib.parse import urlsplit

import poll_loop
from poll_loop import Sink, Stream
from polyroute import Headers, Response
from wit_world.imports import types

__all__ = ["fetch"]

_METHODS = {
    "GET": types.Method_Get,
    "HEAD": types.Method_Head,
    "POST": types.Method_Post,
    "PUT": types.Method_Put,
    "DELETE": types.Method_Delete,
    "CONNECT": types.Method_Connect,
    "OPTIONS": types.Method_Options,
    "TRACE": types.Method_Trace,
    "PATCH": types.Method_Patch,
}


async def fetch(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[Headers] = None,
    body: Union[str, bytes, None] = None,
) -> Response:
    """Sends a request and returns the response, with its body read."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"fetch needs an absolute http or https URL, not {url!r}.")

    items = headers.items() if isinstance(headers, Mapping) else (headers or [])
    request = types.OutgoingRequest(
        types.Fields.from_list([(name.lower(), value.encode("latin-1")) for name, value in items])
    )
    name = method.upper()
    request.set_method(_METHODS[name]() if name in _METHODS else types.Method_Other(method))
    request.set_scheme(types.Scheme_Http() if parts.scheme == "http" else types.Scheme_Https())
    request.set_authority(parts.netloc)
    request.set_path_with_query(f"{parts.path or '/'}{'?' + parts.query if parts.query else ''}")

    if body is None:
        response = await poll_loop.send(request)
    else:
        sink = Sink(request.body())
        # The host may read the body only once it has the request, so the body
        # is written while `send` waits for the response.
        sending = asyncio.ensure_future(poll_loop.send(request))
        await sink.send(body.encode("utf-8") if isinstance(body, str) else body)
        sink.close()
        response = await sending

    with response:
        status = response.status()
        with response.headers() as fields:
            response_headers: List[Tuple[str, str]] = [
                (key, value.decode("latin-1")) for key, value in fields.entries()
            ]
        stream = Stream(response.consume())
        chunks: List[bytes] = []
        while (chunk := await stream.next()) is not None:
            chunks.append(chunk)
    return Response(b"".join(chunks), status, response_headers)
