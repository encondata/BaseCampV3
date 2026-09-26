"""The external tools the wiki worker shells out to: LibreOffice
(`soffice --headless --convert-to pdf`) for office previews, and
poppler's `pdftotext` for search text.

Every subprocess goes through `run`, so tests patch that one function
instead of starting real processes. Each process runs in its own
session (process group): LibreOffice forks a `soffice.bin` child, and
a timeout has to kill that too, not just the launcher."""
from __future__ import annotations

import asyncio
import os
import signal
import tempfile
from pathlib import Path

SOFFICE = "soffice"
PDFTOTEXT = "pdftotext"
SOFFICE_TIMEOUT = 120
PDFTOTEXT_TIMEOUT = 60

# the most text (characters) extraction keeps for search
TEXT_LIMIT = 1_000_000

# how much of a tool's stderr an error message carries
_STDERR_TAIL = 500


class ConvertError(Exception):
    """A tool failed, timed out, or produced nothing — the worker records
    the message on the job and retries."""


async def run(cmd: list[str], *, timeout: float) -> tuple[int, bytes, bytes]:
    """Run `cmd` and return (exit code, stdout, stderr). Raises
    ConvertError after `timeout` seconds, once the whole process group
    has been killed."""
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=True)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
        raise ConvertError(f"{cmd[0]} timed out after {timeout}s") from None
    return proc.returncode, out, err


def _tail(stderr: bytes) -> str:
    return stderr.decode("utf-8", errors="replace").strip()[-_STDERR_TAIL:]


async def office_to_pdf(src: Path, outdir: Path) -> Path:
    """Convert an office document to `<outdir>/<src stem>.pdf` and return
    that path. Each conversion gets a throwaway LibreOffice profile
    (`-env:UserInstallation`), so concurrent conversions never fight over
    one profile's lock."""
    with tempfile.TemporaryDirectory(prefix="wiki-lo-") as profile_dir:
        profile = Path(profile_dir) / "lo"
        rc, _, err = await run(
            [SOFFICE, "--headless", f"-env:UserInstallation={profile.as_uri()}",
             "--convert-to", "pdf", "--outdir", str(outdir), str(src)],
            timeout=SOFFICE_TIMEOUT)
    if rc != 0:
        raise ConvertError(f"soffice exited {rc}: {_tail(err)}")
    pdf = outdir / f"{src.stem}.pdf"
    if not pdf.exists():
        raise ConvertError(f"soffice wrote no PDF: {_tail(err)}")
    return pdf


async def pdf_to_text(src: Path) -> str:
    """The PDF's text (layout-preserving), decoded as UTF-8 with anything
    invalid replaced."""
    rc, out, err = await run(
        [PDFTOTEXT, "-layout", "-enc", "UTF-8", str(src), "-"],
        timeout=PDFTOTEXT_TIMEOUT)
    if rc != 0:
        raise ConvertError(f"pdftotext exited {rc}: {_tail(err)}")
    return out.decode("utf-8", errors="replace")
