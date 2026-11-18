"""Private buffered transfers for Python components built for the native host."""

from types import ModuleType
from typing import Dict

from polyroute import Request, Response, _create_handler
from wit_world.imports import native_http, types


def create_handler(module: ModuleType) -> type:
    return _create_handler(module, _read_request, _send)


def _read_request(request: types.IncomingRequest) -> Request:
    data = native_http.read_request(request)
    headers: Dict[str, str] = {}
    for key, value in data.headers:
        text = value.decode("latin-1")
        headers[key] = f"{headers[key]}, {text}" if key in headers else text
    return Request(data.method, data.url, headers, data.body)


def _send(response: Response, response_out: types.ResponseOutparam) -> None:
    native_http.send_response(
        response_out,
        native_http.ResponseData(
            response.status,
            [(name.lower(), value.encode("latin-1")) for name, value in response.headers],
            response.body,
        ),
    )
