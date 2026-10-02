"""`python -m serversherpa_status` — validate config, then serve on :8080."""

import asyncio
import logging
import os
import sys

import httpx
import uvicorn

from serversherpa_status.alerts import Alert, publish
from serversherpa_status.app import create_app
from serversherpa_status.config import ConfigError, Settings, load_settings


def run_test_alert(settings: Settings) -> int:
    """Send one test notification. 0 sent, 1 publish failed, 2 ntfy not configured."""
    if settings.ntfy is None:
        print("status: STATUS_NTFY_TOPIC is not set; nothing to send to", file=sys.stderr)
        return 2
    alert = Alert("Test alert", "The ServerSherpa status page can reach this topic.", 3, ("white_check_mark",))

    async def send() -> bool:
        async with httpx.AsyncClient() as client:
            return await publish(client, settings.ntfy, alert)

    if asyncio.run(send()):
        print("status: test alert sent")
        return 0
    print("status: test alert failed (see log)", file=sys.stderr)
    return 1


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"status: {exc}", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1:] == ["test-alert"]:
        sys.exit(run_test_alert(settings))
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        proxy_headers=False,
        access_log=False,
    )


if __name__ == "__main__":
    main()
