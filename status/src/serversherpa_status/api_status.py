"""What the API's public /system/status says beyond "I'm up": maintenance
mode, the broadcast announcement, and aggregate worker health. Parsed
tolerantly — an older or odd API simply yields "not known"."""

from dataclasses import dataclass
from datetime import datetime

BACKGROUND_KEY = "background"
BACKGROUND_NAME = "Background processing"
MESSAGE_MAX = 500
_STATES = {"running", "down", "paused"}


@dataclass(frozen=True)
class Background:
    state: str
    running: int
    total: int


@dataclass(frozen=True)
class ApiStatus:
    maintenance: bool
    maintenance_message: str | None
    announcement: str | None
    background: Background | None


def _text(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:MESSAGE_MAX] or None


def _count(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _background(value) -> Background | None:
    if not isinstance(value, dict) or value.get("state") not in _STATES:
        return None
    running, total = _count(value.get("running")), _count(value.get("total"))
    if running is None or total is None:
        return None
    return Background(value["state"], running, total)


def parse_api_status(payload: dict) -> ApiStatus:
    maintenance = payload.get("read_only") is True
    return ApiStatus(
        maintenance=maintenance,
        maintenance_message=_text(payload.get("read_only_message")) if maintenance else None,
        announcement=_text(payload.get("banner")),
        background=_background(payload.get("background")),
    )


class LatestApiStatus:
    def __init__(self) -> None:
        self._value: ApiStatus | None = None
        self._at: datetime | None = None

    def set(self, value: ApiStatus | None, at: datetime) -> None:
        self._value, self._at = value, at

    def get(self, now: datetime, stale_after: float) -> ApiStatus | None:
        if self._value is None or self._at is None:
            return None
        if (now - self._at).total_seconds() > stale_after:
            return None
        return self._value
