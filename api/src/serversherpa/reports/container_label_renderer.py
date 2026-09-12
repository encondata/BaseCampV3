"""Container Labels PDFs come from the PORTAL's own drawing code — a
line-for-line TypeScript port of V2's jsPDF/bwip-js `handleGenerate`
routine (portal/src/labels/containerLabelSheet.ts), run under Node
(portal/dist-node/render-container-labels.js — see portal/src/labels/
renderContainerLabels.ts). One subprocess per report run; every failure
is ContainerLabelRendererUnavailable so the run fails loudly instead of
shipping a truncated or missing PDF. Mirrors reports/rack_renderer.py's
subprocess bridge, but pipes a base64-encoded PDF back over stdout
instead of an SVG string."""

import asyncio
import base64
import json
import os
from pathlib import Path

from serversherpa.config import get_settings

CONTAINER_LABEL_RENDER_TIMEOUT_SECONDS = 30.0


class ContainerLabelRendererUnavailable(Exception):
    pass


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]      # …/api/src/serversherpa/reports → repo


def _script_path() -> str:
    configured = get_settings().report_container_label_renderer
    if configured:
        return configured
    return str(_repo_root() / "portal" / "dist-node" / "render-container-labels.js")


def tag_image_dir() -> str:
    """Where the Node side reads the tag PNGs from — copied verbatim from
    V2 into portal/public/images (priority/vendor/accessories/e-waste/
    warehouse-tag.png). The API ships no image copies of its own."""
    return str(_repo_root() / "portal" / "public" / "images")


def _command(script: str) -> list[str]:
    return [get_settings().report_node_bin, script]


async def render(payload: dict) -> bytes:
    script = _script_path()
    if not os.path.exists(script):
        raise ContainerLabelRendererUnavailable(f"renderer script not found: {script}")
    data = json.dumps(payload).encode()
    try:
        proc = await asyncio.create_subprocess_exec(
            *_command(script), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as exc:
        raise ContainerLabelRendererUnavailable(f"cannot start renderer: {exc}") from exc
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(data), timeout=CONTAINER_LABEL_RENDER_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise ContainerLabelRendererUnavailable(
            f"renderer timed out after {CONTAINER_LABEL_RENDER_TIMEOUT_SECONDS:g}s") from None
    if proc.returncode != 0:
        raise ContainerLabelRendererUnavailable(
            f"renderer exited {proc.returncode}: "
            f"{err.decode(errors='replace').strip()[:500]}")
    try:
        return base64.b64decode(out.strip())
    except Exception as exc:
        raise ContainerLabelRendererUnavailable(f"invalid renderer output: {exc}") from exc
