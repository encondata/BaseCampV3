"""Thin Labelary client (labelary.com renders ZPL to PNG).

forwarders.py convention: builders pure, senders thin and raising —
the route owns error translation (502) and never lets a preview failure
break the editor's canvas preview."""

import httpx

from serversherpa.config import get_settings


def render_url(width_in: float, height_in: float, dpmm: int) -> str:
    base = get_settings().labelary_base_url.rstrip("/")
    return f"{base}/v1/printers/{dpmm}dpmm/labels/{width_in:g}x{height_in:g}/0/"


async def render_png(zpl: str, width_in: float, height_in: float,
                     dpmm: int) -> bytes:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(render_url(width_in, height_in, dpmm),
                                 content=zpl.encode("utf-8"),
                                 headers={"Accept": "image/png"})
    if resp.status_code >= 300:
        raise RuntimeError(
            f"labelary: HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.content
