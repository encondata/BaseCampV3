"""Push alerts to ntfy when the displayed state changes. Titles only —
never URLs or probe detail — and a failed publish never affects checks."""

import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

from serversherpa_status.api_status import BACKGROUND_KEY, BACKGROUND_NAME
from serversherpa_status.config import NtfyConfig, Settings
from serversherpa_status.state import StateTracker

log = logging.getLogger("serversherpa_status.alerts")
PUBLISH_TIMEOUT = 10.0


@dataclass(frozen=True)
class Alert:
    title: str
    message: str
    priority: int
    tags: tuple[str, ...]


def format_duration(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 1:
        return "under a minute"
    hours, minutes = divmod(minutes, 60)
    if not hours:
        return f"{minutes} min"
    return f"{hours} h {minutes} min" if minutes else f"{hours} h"


class AlertWatcher:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names
        self._states: dict[str, str] = {}
        self._down_since: dict[str, datetime] = {}
        self._maintenance: bool | None = None

    def prime(self, states: dict[str, str]) -> None:
        self._states = dict(states)

    def evaluate(
        self,
        states: dict[str, str],
        maintenance: bool | None,
        maintenance_message: str | None,
        now: datetime,
    ) -> list[Alert]:
        alerts: list[Alert] = []
        for key, new in states.items():
            old = self._states.get(key, "unknown")
            name = self._names.get(key, key)
            if new == "down" and old in ("up", "unknown"):
                self._down_since[key] = now
                alerts.append(
                    Alert(f"{name} is down", f"{name} failed its last checks.", 4, ("rotating_light",))
                )
            elif new == "up" and old == "down":
                since = self._down_since.pop(key, None)
                message = (
                    f"Down for {format_duration((now - since).total_seconds())}"
                    if since
                    else f"{name} is responding again."
                )
                alerts.append(Alert(f"{name} is back up", message, 3, ("white_check_mark",)))
            self._states[key] = new
        if maintenance is not None:
            if self._maintenance is False and maintenance:
                alerts.append(
                    Alert(
                        "Maintenance started",
                        maintenance_message or "The system is in read-only maintenance mode.",
                        2,
                        ("construction",),
                    )
                )
            elif self._maintenance is True and not maintenance:
                alerts.append(
                    Alert("Maintenance ended", "Read-only maintenance mode is off.", 2, ("white_check_mark",))
                )
            self._maintenance = maintenance
        return alerts


async def publish(client: httpx.AsyncClient, cfg: NtfyConfig, alert: Alert) -> bool:
    body: dict[str, object] = {
        "topic": cfg.topic,
        "title": alert.title,
        "message": alert.message,
        "priority": alert.priority,
        "tags": list(alert.tags),
    }
    if cfg.click_url:
        body["click"] = cfg.click_url
    headers = {"Authorization": f"Bearer {cfg.token}"} if cfg.token else {}
    try:
        resp = await client.post(f"{cfg.server}/", json=body, headers=headers, timeout=PUBLISH_TIMEOUT)
    except httpx.HTTPError as exc:
        log.warning("ntfy publish failed: %s", type(exc).__name__)
        return False
    except Exception as exc:  # never let a publish problem escape
        log.warning("ntfy publish failed: %s", type(exc).__name__)
        return False
    if resp.status_code >= 300:
        log.warning("ntfy publish failed: HTTP %s", resp.status_code)
        return False
    return True


def build_watcher(settings: Settings, tracker: StateTracker) -> AlertWatcher | None:
    """A watcher primed with the states loaded from history, so a restart never
    re-announces something that was already down. None when ntfy is off."""
    if settings.ntfy is None:
        return None
    keys = [s.key for s in settings.services] + [BACKGROUND_KEY]
    watcher = AlertWatcher(
        {s.key: s.name for s in settings.services} | {BACKGROUND_KEY: BACKGROUND_NAME}
    )
    watcher.prime({k: tracker.snapshot(k).state for k in keys})
    return watcher
