"""Environment → Settings. Fails loudly: a status page pointed at nothing
would render a permanent 'Checking…', which is worse than not starting."""

import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("serversherpa_status.config")

DEFAULT_STATIC_DIR = str(Path(__file__).parent / "static")

# (key, display name, env var, required) — order is the display order on the
# page. The page only ever shows the display name, never the URL. Optional
# services are left off the page entirely while their env var is unset, so
# adding one never breaks an existing deployment's .env.
SERVICES = (
    ("api", "API", "STATUS_API_URL", True),
    ("portal", "Portal", "STATUS_PORTAL_URL", True),
    ("kiosk", "Kiosk", "STATUS_KIOSK_URL", True),
    ("wiki", "Wiki", "STATUS_WIKI_URL", False),
)


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Service:
    key: str
    name: str
    url: str


@dataclass(frozen=True)
class NtfyConfig:
    server: str
    topic: str
    token: str | None
    click_url: str | None


@dataclass(frozen=True)
class Settings:
    services: tuple[Service, ...]
    interval_seconds: float
    timeout_seconds: float
    failure_threshold: int
    db_path: str
    static_dir: str
    ntfy: NtfyConfig | None = None


def _number(env: Mapping[str, str], var: str, default: float, minimum: float) -> float:
    raw = env.get(var, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{var} must be a number (got {raw!r})") from None
    if value < minimum:
        raise ConfigError(f"{var} must be at least {minimum:g} (got {raw!r})")
    return value


NTFY_TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _http_url(env: Mapping[str, str], var: str, default: str = "") -> str:
    url = env.get(var, "").strip().rstrip("/") or default
    if url and not url.startswith(("http://", "https://")):
        raise ConfigError(f"{var} must start with http:// or https:// (got {url!r})")
    return url


def _load_ntfy(env: Mapping[str, str]) -> NtfyConfig | None:
    topic = env.get("STATUS_NTFY_TOPIC", "").strip()
    if not topic:
        return None
    if not NTFY_TOPIC_RE.match(topic):
        raise ConfigError(
            "STATUS_NTFY_TOPIC may only use letters, digits, - and _ (max 64 characters)"
        )
    server = _http_url(env, "STATUS_NTFY_SERVER", "https://ntfy.sh")
    token = env.get("STATUS_NTFY_TOKEN", "").strip() or None
    if token and server.startswith("http://"):
        log.warning(
            "STATUS_NTFY_TOKEN is set but STATUS_NTFY_SERVER is cleartext http://; "
            "the token is sent unencrypted. Use an https:// server."
        )
    return NtfyConfig(
        server=server,
        topic=topic,
        token=token,
        click_url=_http_url(env, "STATUS_PUBLIC_URL") or None,
    )


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    services = []
    for key, name, var, required in SERVICES:
        url = env.get(var, "").strip().rstrip("/")
        if not url and not required:
            continue
        if not url:
            raise ConfigError(f"{var} is required (e.g. https://{key}.serversherpa.com)")
        if not url.startswith(("http://", "https://")):
            raise ConfigError(f"{var} must start with http:// or https:// (got {url!r})")
        services.append(Service(key, name, url))

    threshold_raw = env.get("STATUS_FAILURE_THRESHOLD", "").strip() or "2"
    try:
        threshold = int(threshold_raw)
    except ValueError:
        raise ConfigError(
            f"STATUS_FAILURE_THRESHOLD must be a whole number (got {threshold_raw!r})"
        ) from None
    if threshold < 1:
        raise ConfigError(f"STATUS_FAILURE_THRESHOLD must be at least 1 (got {threshold_raw!r})")

    return Settings(
        services=tuple(services),
        interval_seconds=_number(env, "STATUS_INTERVAL_SECONDS", 60, 10),
        timeout_seconds=_number(env, "STATUS_TIMEOUT_SECONDS", 10, 0.1),
        failure_threshold=threshold,
        db_path=env.get("STATUS_DB_PATH", "").strip() or "/data/status.db",
        static_dir=env.get("STATUS_STATIC_DIR", "").strip() or DEFAULT_STATIC_DIR,
        ntfy=_load_ntfy(env),
    )


def stale_after_seconds(settings: Settings) -> float:
    """A service (or the checker itself) is stale once this long has passed
    without a fresh check — three missed intervals plus one probe timeout,
    so a single slow cycle never flips things to 'unknown' on its own."""
    return 3 * settings.interval_seconds + settings.timeout_seconds
