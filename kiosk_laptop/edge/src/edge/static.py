"""The kiosk bundle: real files when they exist under web_dir, index.html
for everything else (client-side routes like /labels/printers)."""

from pathlib import Path

from fastapi.responses import FileResponse


def serve(web_dir: Path, path: str) -> FileResponse:
    root = web_dir.resolve()
    candidate = (root / path.lstrip("/")).resolve()
    if candidate.is_file() and candidate.is_relative_to(root):
        return FileResponse(candidate)
    return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
