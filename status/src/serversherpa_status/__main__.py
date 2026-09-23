"""`python -m serversherpa_status` — validate config, then serve on :8080."""

import logging
import os
import sys

import uvicorn

from serversherpa_status.app import create_app
from serversherpa_status.config import ConfigError, load_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"status: {exc}", file=sys.stderr)
        sys.exit(2)
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,
    )


if __name__ == "__main__":
    main()
