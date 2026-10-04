"""The one switch for Sirdar's outbound HTTP to publish environments
(Cloudflare, Nginx Proxy Manager, smoke tests): every client gets its
transport from transports() when it is built. None means httpx's real
transport; tests replace this function with fakes (and a conftest guard
fails any real request)."""

import httpx

KINDS = ("cloudflare", "npm", "smoke")


def transports() -> dict[str, httpx.AsyncBaseTransport | None]:
    return {kind: None for kind in KINDS}
