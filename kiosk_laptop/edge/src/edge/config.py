"""Runtime settings, read from EDGE_* environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    cloud_api_url: str
    portal_url: str = ""
    data_dir: Path = Path("/data")
    web_dir: Path = Path("/app/web")
    offline_login_days: int = 14
    sync_interval_s: int = 300
    probe_interval_s: int = 30
    background: bool = True
    secure_cookies: bool = False
    # Host names the edge answers besides localhost/127.0.0.1/[::1]
    # (TrustedHostMiddleware: a DNS-rebinding page gets 400).
    allowed_hosts: tuple[str, ...] = ()
    version: str = "dev"


def load_settings() -> Settings:
    cloud = os.environ.get("EDGE_CLOUD_API_URL", "").strip().rstrip("/")
    if not cloud:
        raise RuntimeError("EDGE_CLOUD_API_URL is required (e.g. https://api.serversherpa.com)")
    return Settings(
        cloud_api_url=cloud,
        portal_url=os.environ.get("EDGE_PORTAL_URL", "").strip().rstrip("/"),
        data_dir=Path(os.environ.get("EDGE_DATA_DIR", "/data")),
        web_dir=Path(os.environ.get("EDGE_WEB_DIR", "/app/web")),
        offline_login_days=int(os.environ.get("EDGE_OFFLINE_LOGIN_DAYS", "14")),
        sync_interval_s=int(os.environ.get("EDGE_SYNC_INTERVAL_S", "300")),
        background=os.environ.get("EDGE_BACKGROUND", "1") != "0",
        secure_cookies=os.environ.get("EDGE_SECURE_COOKIES", "0") == "1",
        allowed_hosts=tuple(h.strip() for h in os.environ.get("EDGE_ALLOWED_HOSTS", "").split(",")
                            if h.strip()),
        version=os.environ.get("EDGE_VERSION", "dev").strip() or "dev",
    )
