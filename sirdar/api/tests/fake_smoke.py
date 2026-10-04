"""Answers the smoke test's requests by their Host header: a status code,
or "tls" (certificate didn't verify), "down" (refused) or "slow" (timeout).
Each hostname's answers are used in turn; the last one repeats."""

import ssl

import httpx


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
        answer = (queue.pop(0) if len(queue) > 1 else queue[0]) if queue else self.default
        if answer == "tls":                 # chained like httpcore's: no "SSL" in the text
            try:
                raise ssl.SSLCertVerificationError(1, "certificate verify failed")
            except ssl.SSLError as e:
                raise httpx.ConnectError("handshake failed", request=request) from e
        if answer == "down":
            raise httpx.ConnectError("[Errno 111] Connection refused", request=request)
        if answer == "slow":
            raise httpx.ReadTimeout("timed out", request=request)
        return httpx.Response(answer)
