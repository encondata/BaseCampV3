"""wiki.convert — the LibreOffice/poppler wrappers the wiki worker runs.

Every unit test patches `convert.run` (or, for `run` itself, the
subprocess factory), so no real process starts. The one integration
test at the bottom converts a tiny generated .docx for real and skips
itself when `soffice` or `pdftotext` isn't installed."""
import asyncio
import shutil
import zipfile
from pathlib import Path

import pytest

from serversherpa.wiki import convert
from serversherpa.wiki.convert import ConvertError

# ── office_to_pdf ────────────────────────────────────────────────────


async def test_office_to_pdf_builds_the_soffice_argv(tmp_path, monkeypatch):
    src = tmp_path / "in" / "Quarterly plan.docx"
    src.parent.mkdir()
    src.write_bytes(b"docx")
    outdir = tmp_path / "out"
    outdir.mkdir()
    calls = []

    async def fake_run(cmd, *, timeout):
        calls.append((cmd, timeout))
        (outdir / "Quarterly plan.pdf").write_bytes(b"%PDF-1.4")
        return 0, b"", b""

    monkeypatch.setattr(convert, "run", fake_run)
    pdf = await convert.office_to_pdf(src, outdir)

    assert pdf == outdir / "Quarterly plan.pdf"
    [(cmd, timeout)] = calls
    assert timeout == 120
    assert cmd[0] == "soffice"
    assert cmd[1] == "--headless"
    # an isolated LibreOffice profile per conversion, as a file:// URI
    assert cmd[2].startswith("-env:UserInstallation=file://")
    assert cmd[2].endswith("/lo")
    assert cmd[3:] == ["--convert-to", "pdf", "--outdir", str(outdir), str(src)]


async def test_office_to_pdf_uses_a_fresh_profile_each_time(tmp_path, monkeypatch):
    src = tmp_path / "a.docx"
    src.write_bytes(b"docx")
    profiles = []

    async def fake_run(cmd, *, timeout):
        profiles.append(cmd[2])
        (tmp_path / "a.pdf").write_bytes(b"%PDF-1.4")
        return 0, b"", b""

    monkeypatch.setattr(convert, "run", fake_run)
    await convert.office_to_pdf(src, tmp_path)
    await convert.office_to_pdf(src, tmp_path)
    assert profiles[0] != profiles[1]


async def test_office_to_pdf_raises_on_nonzero_exit(tmp_path, monkeypatch):
    src = tmp_path / "a.docx"
    src.write_bytes(b"docx")

    async def fake_run(cmd, *, timeout):
        return 1, b"", b"Error: source file could not be loaded"

    monkeypatch.setattr(convert, "run", fake_run)
    with pytest.raises(ConvertError, match="could not be loaded"):
        await convert.office_to_pdf(src, tmp_path)


async def test_office_to_pdf_raises_when_no_pdf_appears(tmp_path, monkeypatch):
    # soffice sometimes exits 0 without writing anything
    src = tmp_path / "a.docx"
    src.write_bytes(b"docx")

    async def fake_run(cmd, *, timeout):
        return 0, b"", b""

    monkeypatch.setattr(convert, "run", fake_run)
    with pytest.raises(ConvertError, match="no PDF"):
        await convert.office_to_pdf(src, tmp_path)


async def test_office_to_pdf_passes_a_timeout_through(tmp_path, monkeypatch):
    src = tmp_path / "a.docx"
    src.write_bytes(b"docx")

    async def fake_run(cmd, *, timeout):
        raise ConvertError(f"soffice timed out after {timeout}s")

    monkeypatch.setattr(convert, "run", fake_run)
    with pytest.raises(ConvertError, match="timed out after 120s"):
        await convert.office_to_pdf(src, tmp_path)


# ── pdf_to_text ──────────────────────────────────────────────────────


async def test_pdf_to_text_builds_the_argv_and_decodes(tmp_path, monkeypatch):
    src = tmp_path / "a.pdf"
    calls = []

    async def fake_run(cmd, *, timeout):
        calls.append((cmd, timeout))
        return 0, "Café \xff".encode("latin-1") + b" rack", b""

    monkeypatch.setattr(convert, "run", fake_run)
    text = await convert.pdf_to_text(src)
    assert calls == [(["pdftotext", "-layout", "-enc", "UTF-8", str(src), "-"], 60)]
    # invalid UTF-8 is replaced, never raised
    assert text.endswith(" rack")
    assert "�" in text


async def test_pdf_to_text_raises_on_nonzero_exit(tmp_path, monkeypatch):
    async def fake_run(cmd, *, timeout):
        return 1, b"", b"Syntax Error: Couldn't find trailer dictionary"

    monkeypatch.setattr(convert, "run", fake_run)
    with pytest.raises(ConvertError, match="trailer dictionary"):
        await convert.pdf_to_text(tmp_path / "a.pdf")


# ── run ──────────────────────────────────────────────────────────────


class _FakeProc:
    def __init__(self, *, hang: bool):
        self.hang = hang
        self.pid = 999_999
        self.returncode = None
        self.killed = False

    async def communicate(self):
        if self.hang:
            await asyncio.sleep(3600)
        self.returncode = 0
        return b"out", b"err"

    def kill(self):
        self.killed = True

    async def wait(self):
        self.returncode = -9
        return -9


async def test_run_returns_exit_code_and_output(monkeypatch):
    proc = _FakeProc(hang=False)
    seen = {}

    async def fake_exec(*args, **kwargs):
        seen["args"], seen["kwargs"] = args, kwargs
        return proc

    monkeypatch.setattr(convert.asyncio, "create_subprocess_exec", fake_exec)
    assert await convert.run(["pdftotext", "x"], timeout=5) == (0, b"out", b"err")
    assert seen["args"] == ("pdftotext", "x")
    # its own process group, so a timeout can kill soffice's children too
    assert seen["kwargs"]["start_new_session"] is True


async def test_run_kills_the_process_group_on_timeout(monkeypatch):
    proc = _FakeProc(hang=True)
    killed = []

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(convert.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(convert.os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    with pytest.raises(ConvertError, match="timed out after 0.05s"):
        await convert.run(["soffice", "--headless"], timeout=0.05)
    assert killed and killed[0][0] == proc.pid


# ── the real thing ───────────────────────────────────────────────────

_DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml"
 ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
_DOCX_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
 Target="word/document.xml"/>
</Relationships>"""
_DOCX_DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body>
</w:document>"""


def _write_docx(path: Path, text: str) -> None:
    """A minimal valid .docx (three parts) — no python-docx needed."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES)
        z.writestr("_rels/.rels", _DOCX_RELS)
        z.writestr("word/document.xml", _DOCX_DOCUMENT.format(text=text))


@pytest.mark.skipif(shutil.which("soffice") is None or shutil.which("pdftotext") is None,
                    reason="LibreOffice (soffice) and poppler (pdftotext) are not installed")
async def test_real_docx_converts_to_pdf_and_extracts_text(tmp_path):
    src = tmp_path / "Rack plan.docx"
    _write_docx(src, "Sherpa rack elevation checklist")
    outdir = tmp_path / "out"
    outdir.mkdir()

    pdf = await convert.office_to_pdf(src, outdir)
    assert pdf.exists() and pdf.read_bytes().startswith(b"%PDF")
    text = await convert.pdf_to_text(pdf)
    assert "Sherpa rack elevation checklist" in text
