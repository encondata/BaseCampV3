"""Rack elevations for PDFs come from the PORTAL's own SVG component, run
under Node (portal/dist-node/render-rack.js — see portal/src/reports/
renderRack.tsx). One subprocess per rack; every failure is
RackRendererUnavailable so the run fails loudly instead of shipping a PDF
with silently missing sections."""

import asyncio
import json
import os
from pathlib import Path

from serversherpa.config import get_settings

RACK_RENDER_TIMEOUT_SECONDS = 30.0


class RackRendererUnavailable(Exception):
    pass


def _script_path() -> str:
    configured = get_settings().report_rack_renderer
    if configured:
        return configured
    repo_root = Path(__file__).resolve().parents[4]      # …/api/src/serversherpa/reports → repo
    return str(repo_root / "portal" / "dist-node" / "render-rack.js")


def _command(script: str) -> list[str]:
    return [get_settings().report_node_bin, script]


async def render(rows: list[dict], rack_name: str, side: str) -> str:
    script = _script_path()
    if not os.path.exists(script):
        raise RackRendererUnavailable(f"renderer script not found: {script}")
    payload = json.dumps({"rackName": rack_name, "side": side, "rows": rows}).encode()
    try:
        proc = await asyncio.create_subprocess_exec(
            *_command(script), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as exc:
        raise RackRendererUnavailable(f"cannot start renderer: {exc}") from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload),
                                          timeout=RACK_RENDER_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise RackRendererUnavailable(
            f"renderer timed out after {RACK_RENDER_TIMEOUT_SECONDS:g}s for rack {rack_name}") from None
    if proc.returncode != 0:
        raise RackRendererUnavailable(
            f"renderer exited {proc.returncode} for rack {rack_name}: "
            f"{err.decode(errors='replace').strip()[:500]}")
    return out.decode("utf-8", "replace")
