"""A request-body size limit for every path, as pure ASGI middleware. It
runs before routing, so before sign-in: FastAPI reads a form body (spooling
file parts to disk) before a route's dependencies run.

This service never takes large bodies (packages go straight to the bucket
through presigned PUTs), so one limit fits every route. A declared
Content-Length over the limit is refused without reading anything; a body
without one (chunked) is counted as it arrives and refused once it passes
the limit."""

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

TOO_LARGE_BODY = json.dumps(
    {"detail": {"code": "too_large", "message": "This request is too large."}}).encode()


class _TooLarge(Exception):
    """Raised from receive() once the streamed body passes the limit."""


async def _send_413(send: Send) -> None:
    await send({"type": "http.response.start", "status": 413,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(TOO_LARGE_BODY)).encode()),
                            (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": TOO_LARGE_BODY})


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _declared_length(scope)
        if declared is not None and declared > self.max_bytes:
            await _send_413(send)
            return

        received = 0
        tripped = False
        started = False

        async def limited_receive() -> Message:
            nonlocal received, tripped
            if tripped:
                raise _TooLarge
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    tripped = True
                    raise _TooLarge
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            # A parser may turn _TooLarge into its own error answer (FastAPI
            # answers 400 for a body it couldn't parse): send the 413 instead.
            if tripped and not started:
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _TooLarge:
            pass
        if tripped and not started:
            await _send_413(send)
