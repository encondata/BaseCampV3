"""Which server this laptop talks to, and whether any server has ever
registered it. Both live in the data folder next to identity.json, so Wipe
leaves them alone.

environment.json holds the kiosk's choice: `{"kind": "named", "id", "name",
"domain"}` or `{"kind": "custom", "api_url", "portal_url"}`. When it exists
and is valid it wins over the installer's EDGE_CLOUD_API_URL /
EDGE_PORTAL_URL, and a later list never moves it: the saved domain is the
one used. Without it (or when it is unreadable) the installer's values are
used as today: an API URL of `https://api.<domain>` for a built-in entry
names that environment, anything else is Custom. Nothing is written until
someone switches.

registered.json (`{"registered_at": iso}`) is written the first time a
heartbeat reply says the kiosk is registered, or a station key is issued.
Nothing in the edge removes it; only a fresh install or clearing the data
folder does. Any file there counts, even an unreadable one: the flag only
ever makes the switch rules stricter."""

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from edge.config import Settings
from edge.db import now_iso
from edge.environments import BUILT_IN, ROOT_DOMAIN, Env, to_env

ENVIRONMENT_FILE = "environment.json"
REGISTERED_FILE = "registered.json"
CUSTOM_NAME = "Custom"

log = logging.getLogger("edge.environment_store")


@dataclass(frozen=True)
class Current:
    kind: Literal["named", "custom"]
    id: str | None
    name: str
    domain: str | None
    api_url: str
    portal_url: str

    @property
    def is_prod(self) -> bool:
        return self.kind == "named" and self.domain == ROOT_DOMAIN

    @classmethod
    def named(cls, env: Env) -> "Current":
        return cls(kind="named", id=env.id, name=env.name, domain=env.domain,
                   api_url=env.api_url, portal_url=env.portal_url)

    @classmethod
    def custom(cls, api_url: str, portal_url: str) -> "Current":
        return cls(kind="custom", id=None, name=CUSTOM_NAME, domain=None, api_url=api_url,
                   portal_url=portal_url)


def _write_json(path: Path, doc: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc))
    os.replace(tmp, path)


def _url(value: object, *, empty_ok: bool = False) -> str | None:
    """An http(s) URL with a host, trailing `/` removed; None when not."""
    if not isinstance(value, str):
        return None
    value = value.strip().rstrip("/")
    if not value:
        return "" if empty_ok else None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return value


def _from_saved(doc: object) -> Current | None:
    if not isinstance(doc, dict):
        return None
    if doc.get("kind") == "named":
        env = to_env(doc)
        return Current.named(env) if env is not None else None
    if doc.get("kind") == "custom":
        api_url = _url(doc.get("api_url"))
        portal_url = _url(doc.get("portal_url"), empty_ok=True)
        if api_url is None or portal_url is None:
            return None
        return Current.custom(api_url, portal_url)
    return None


def from_installer(settings: Settings) -> Current:
    """The installer's URLs: a built-in environment when the API URL is
    exactly its `https://api.<domain>`, else Custom with both URLs as given."""
    for env in BUILT_IN:
        if settings.cloud_api_url == env.api_url:
            return Current.named(env)
    return Current.custom(settings.cloud_api_url, settings.portal_url)


def load_current(data_dir: Path, settings: Settings) -> Current:
    try:
        saved = _from_saved(json.loads((data_dir / ENVIRONMENT_FILE).read_text()))
    except (OSError, ValueError):
        saved = None
    return saved if saved is not None else from_installer(settings)


def save_current(data_dir: Path, cur: Current) -> None:
    if cur.kind == "named":
        doc = {"kind": "named", "id": cur.id, "name": cur.name, "domain": cur.domain}
    else:
        doc = {"kind": "custom", "api_url": cur.api_url, "portal_url": cur.portal_url}
    _write_json(data_dir / ENVIRONMENT_FILE, doc)


def ever_registered(data_dir: Path) -> bool:
    return (data_dir / REGISTERED_FILE).exists()


def mark_registered(data_dir: Path) -> None:
    """Set the flag; the first time it was set is kept."""
    if ever_registered(data_dir):
        return
    try:
        _write_json(data_dir / REGISTERED_FILE, {"registered_at": now_iso()})
    except OSError as exc:  # a full disk must not break the heartbeat; the next one retries
        log.warning("registered flag not saved: %s", type(exc).__name__)


def note_heartbeat_reply(data_dir: Path, data: object) -> None:
    """A heartbeat reply whose `registration` is anything but "none" means
    some server has registered this kiosk."""
    if isinstance(data, dict) and isinstance(data.get("registration"), str) \
            and data["registration"] != "none":
        mark_registered(data_dir)
