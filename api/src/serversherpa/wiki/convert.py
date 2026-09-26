"""The external tools the wiki worker shells out to: LibreOffice
(`soffice --headless --convert-to pdf`) for office previews and
(`--convert-to docx`) for Word exports, and poppler's `pdftotext` for
search text.

Every subprocess goes through `run`, so tests patch that one function
instead of starting real processes. Each process runs in its own
session (process group): a timeout — or any other failure, including
cancellation — has to kill the whole group, not just the launcher,
since LibreOffice forks a `soffice.bin` child."""
from __future__ import annotations

import asyncio
import os
import signal
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path

SOFFICE = "soffice"
PDFTOTEXT = "pdftotext"
SOFFICE_TIMEOUT = 120
PDFTOTEXT_TIMEOUT = 60

# the most text (characters) extraction keeps for search
TEXT_LIMIT = 1_000_000

# UTF-8 is at most this many bytes a character, so reading this many
# bytes always covers TEXT_LIMIT characters
_BYTES_PER_CHAR = 4

# how much of a tool's stderr an error message carries
_STDERR_TAIL = 500

# how much of a stream `_read_capped` pulls per read() call
_READ_CHUNK = 65536


class ConvertError(Exception):
    """A tool failed, timed out, or produced nothing — the worker records
    the message on the job and retries."""


async def _kill_group(proc: asyncio.subprocess.Process) -> None:
    """SIGKILL the process's whole group (it may have forked children —
    LibreOffice forks a `soffice.bin`) and reap it. Safe to call even if
    it has already exited."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()


async def _read_capped(stream: asyncio.StreamReader, limit: int) -> tuple[bytes, bool]:
    """Read at most `limit` bytes from `stream`, in chunks (never the
    whole thing in one buffer). Returns (data, capped) — `capped` is
    True when the limit was hit before the stream ran out on its own."""
    chunks: list[bytes] = []
    total = 0
    while total < limit:
        chunk = await stream.read(min(_READ_CHUNK, limit - total))
        if not chunk:
            return b"".join(chunks), False
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks), True


async def _communicate_capped(proc: asyncio.subprocess.Process,
                              max_stdout: int) -> tuple[bytes, bytes]:
    """Like `proc.communicate()`, but stdout is read incrementally and
    capped at `max_stdout` bytes: once that many have come through
    without the stream ending, the process group is killed right away
    instead of letting the tool keep running to produce output nobody
    wants. Stderr is drained concurrently the whole time so a chatty
    tool can't deadlock on a full pipe while only stdout is watched."""
    stderr_task = asyncio.ensure_future(proc.stderr.read())
    out, capped = await _read_capped(proc.stdout, max_stdout)
    if capped:
        stderr_task.cancel()
        await _kill_group(proc)
        return out, b""
    err = await stderr_task
    await proc.wait()
    return out, err


async def run(cmd: list[str], *, timeout: float,
              max_stdout: int | None = None) -> tuple[int, bytes, bytes]:
    """Run `cmd` and return (exit code, stdout, stderr). Raises
    ConvertError after `timeout` seconds, once the whole process group
    has been killed. The group is killed on any other failure too —
    including `asyncio.CancelledError`, when the caller (a worker job)
    is cancelled mid-conversion — so a killed request never leaves
    `soffice`/`pdftotext` running orphaned; the original exception is
    always re-raised unchanged.

    `max_stdout`, when given, caps how much of stdout is buffered: past
    that many bytes the process group is killed and whatever came
    through is returned (the exit code reflects the kill, not a real
    one) — `pdf_to_text` uses this so a pathological PDF can't buffer
    unbounded text in memory."""
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=True)
    try:
        if max_stdout is None:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        else:
            out, err = await asyncio.wait_for(
                _communicate_capped(proc, max_stdout), timeout)
    except TimeoutError:
        await _kill_group(proc)
        raise ConvertError(f"{cmd[0]} timed out after {timeout}s") from None
    except BaseException:
        await _kill_group(proc)
        raise
    return proc.returncode, out, err


def _tail(stderr: bytes) -> str:
    return stderr.decode("utf-8", errors="replace").strip()[-_STDERR_TAIL:]


def _clean_text(value: str) -> str:
    # Postgres text can't hold NUL
    return value.replace("\x00", "")[:TEXT_LIMIT]


async def office_to_pdf(src: Path, outdir: Path) -> Path:
    """Convert an office document to `<outdir>/<src stem>.pdf` and return
    that path. Each conversion gets a throwaway LibreOffice profile
    (`-env:UserInstallation`), so concurrent conversions never fight over
    one profile's lock. `ignore_cleanup_errors` so a stray file LibreOffice
    still has open can't turn cleanup into the error the caller sees,
    masking whatever actually went wrong."""
    with tempfile.TemporaryDirectory(prefix="wiki-lo-",
                                     ignore_cleanup_errors=True) as profile_dir:
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


# the Word export filter; how many HTML files one LibreOffice run converts
# (each run pays LibreOffice's start-up once); and a run's timeout — a
# base plus so much per file, so a batch scales with its size
DOCX_FILTER = "docx:MS Word 2007 XML"
DOCX_BATCH = 5
DOCX_BASE_TIMEOUT = 60
DOCX_PER_FILE_TIMEOUT = 20


async def html_to_docx(sources: list[Path], *,
                       touch: Callable[[], Awaitable[None]] | None = None) -> list[Path]:
    """Convert HTML files to Word documents, each written beside its
    source as `<stem>.docx` (same directory, so relative links in the
    HTML stay relative to the same place), and return those paths in
    order. Up to DOCX_BATCH files share one LibreOffice run (each with a
    throwaway profile like `office_to_pdf`'s, and a timeout of
    DOCX_BASE_TIMEOUT + DOCX_PER_FILE_TIMEOUT per file); `touch`, when
    given, is awaited after each run — the caller's progress heartbeat."""
    out: list[Path] = []
    for i in range(0, len(sources), DOCX_BATCH):
        batch = sources[i:i + DOCX_BATCH]
        by_dir: dict[Path, list[Path]] = {}
        for src in batch:
            by_dir.setdefault(src.parent, []).append(src)
        for outdir, files in by_dir.items():
            with tempfile.TemporaryDirectory(prefix="wiki-lo-",
                                             ignore_cleanup_errors=True) as profile_dir:
                profile = Path(profile_dir) / "lo"
                rc, _, err = await run(
                    [SOFFICE, "--headless", f"-env:UserInstallation={profile.as_uri()}",
                     "--convert-to", DOCX_FILTER, "--outdir", str(outdir),
                     *(str(f) for f in files)],
                    timeout=DOCX_BASE_TIMEOUT + DOCX_PER_FILE_TIMEOUT * len(files))
            if rc != 0:
                raise ConvertError(f"soffice exited {rc}: {_tail(err)}")
        for src in batch:
            docx = src.with_suffix(".docx")
            if not docx.exists():
                raise ConvertError(f"soffice wrote no .docx for {src.name}")
            out.append(docx)
        if touch is not None:
            await touch()
    return out


async def pdf_to_text(src: Path) -> str:
    """The PDF's text (layout-preserving), decoded as UTF-8 with anything
    invalid replaced, cleaned and capped at TEXT_LIMIT characters.
    Stdout is capped at TEXT_LIMIT * _BYTES_PER_CHAR bytes while reading
    (see `run`'s `max_stdout`) — enough to cover the cap however the
    text is encoded, without ever buffering a pathologically large PDF's
    full output just to throw most of it away."""
    cap = TEXT_LIMIT * _BYTES_PER_CHAR
    rc, out, err = await run(
        [PDFTOTEXT, "-layout", "-enc", "UTF-8", str(src), "-"],
        timeout=PDFTOTEXT_TIMEOUT, max_stdout=cap)
    if len(out) < cap and rc != 0:
        raise ConvertError(f"pdftotext exited {rc}: {_tail(err)}")
    return _clean_text(out.decode("utf-8", errors="replace"))
