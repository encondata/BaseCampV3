"""Answers the smoke test's requests by their Host header: a status code, a
(status, Location) pair, or "tls" (certificate didn't verify), "down"
(refused) or "slow" (timeout). Each hostname's answers are used in turn;
the last one repeats. A hostname with no answers gets the default, except a
bare environment name, which redirects to its portal as NPM and Caddy do."""

import ssl

import httpx

from sirdar_api.deploy import envfile


def is_bare(hostname: str) -> bool:
    """An environment's own name: no service label in front."""
    return hostname.split(".", 1)[0] not in envfile.SERVICES


def portal_redirect(request: httpx.Request) -> httpx.Response:
    host = request.headers["host"]
    return httpx.Response(302, headers={
        "location": f"https://portal.{host}{request.url.raw_path.decode()}"})


def respond(request: httpx.Request, status: int) -> httpx.Response:
    """`status` for a service's name; a bare name redirects to its portal
    while `status` is a pass (below 400)."""
    if status < 400 and is_bare(request.headers["host"]):
        return portal_redirect(request)
    return httpx.Response(status)


class FakeSmoke:
    def __init__(self, default: int = 200):
        self.default = default
        self.answers: dict[str, list] = {}
        self.requests: list[httpx.Request] = []

    def set(self, hostname: str, *answers) -> None:
        self.answers[hostname] = list(answers)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.answers.get(request.headers["host"])
        answer = (queue.pop(0) if len(queue) > 1 else queue[0]) if queue else None
        if answer is None:
            return respond(request, self.default)
        if answer == "tls":                 # chained like httpcore's: no "SSL" in the text
            try:
                raise ssl.SSLCertVerificationError(1, "certificate verify failed")
            except ssl.SSLError as e:
                raise httpx.ConnectError("handshake failed", request=request) from e
        if answer == "down":
            raise httpx.ConnectError("[Errno 111] Connection refused", request=request)
        if answer == "slow":
            raise httpx.ReadTimeout("timed out", request=request)
        if isinstance(answer, tuple):
            status, location = answer
            return httpx.Response(status, headers={"location": location} if location else {})
        return httpx.Response(answer)
