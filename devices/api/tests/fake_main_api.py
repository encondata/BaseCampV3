"""A respx-mocked main API for the sign-in bridge. It is reached through an
httpx.MockTransport handed to MainApiClient, so no_real_http never sees it.

    fake = FakeMainApi()        # answers as a staff portal session
    fake.as_admin()             # every action
    fake.as_kiosk()             # a kiosk session
    fake.revoked()              # 401 unauthenticated
    fake.authorize_route / fake.audit_route   # respx routes: calls, call_count
"""

import uuid

import httpx
import respx

MAIN_API_URL = "http://main-api.test"
AUTHORIZE_PATH = "/app-distribution/internal/authorize"
AUDIT_PATH = "/app-distribution/internal/audit"

PERSON_ID = uuid.UUID("0b6f2c39-5d7e-4c1a-9a51-1f0a7d3c2e11")


class FakeMainApi:
    def __init__(self, base_url: str = MAIN_API_URL) -> None:
        self.router = respx.Router(base_url=base_url, assert_all_called=False)
        self.authorize_route = self.router.get(AUTHORIZE_PATH)
        self.audit_route = self.router.post(AUDIT_PATH)
        self.audit_route.respond(204)
        self.as_staff()

    def transport(self) -> httpx.AsyncBaseTransport:
        return httpx.MockTransport(self.router.async_handler)

    def _answer(self, **fields) -> None:
        body = {
            "person_id": str(PERSON_ID),
            "display_name": "Pat Example",
            "email": "pat@example.test",
            "client": "portal",
            "kiosk_serial": None,
            "actions": ["view"],
            "password_change_required": False,
            "read_only": False,
            "read_only_message": None,
        }
        body.update(fields)
        self.authorize_route.respond(200, json=body)

    def as_staff(self, **fields) -> None:
        self._answer(**{"actions": ["view"], **fields})

    def as_admin(self, **fields) -> None:
        self._answer(**{"actions": ["view", "add", "change", "delete"], **fields})

    def as_kiosk(self, **fields) -> None:
        self._answer(**{"client": "kiosk", "kiosk_serial": "KIOSK-0001",
                        "actions": ["view", "add", "change", "delete"], **fields})

    def revoked(self) -> None:
        self.authorize_route.respond(
            401, json={"detail": {"code": "unauthenticated", "message": "Sign in to continue."}})

    def authorize_error(self, status: int, code: str | None = None) -> None:
        """A non-user failure: 5xx, or the main API rejecting our service token."""
        body = {"detail": {"code": code, "message": "x"}} if code else {"detail": "boom"}
        self.authorize_route.respond(status, json=body)

    def authorize_unreachable(self) -> None:
        self.authorize_route.mock(side_effect=httpx.ConnectError("connection refused"))


class FakeClock:
    """An injectable time.monotonic."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
