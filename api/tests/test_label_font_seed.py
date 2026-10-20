"""Seeding the label builder's font library (spec §4.4): the fourteen open
TrueType files from pinned GitHub URLs, and the resident Swiss 721
Condensed Bold row, which has no file. Downloads and object storage are
faked: the suite never fetches a font."""

import re
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, LabelFont
from serversherpa.labels import font_seed
from serversherpa.labels.fonts import FAMILIES

# object name → (family, weight, display name, resident)
EXPECTED = {
    "TT0003M_.TTF": ("swiss721-cond-bold", "regular", "Swiss 721 Condensed Bold", True),
    "ROBOCO_R.TTF": ("roboto-condensed", "regular", "Roboto Condensed Regular", False),
    "ROBOCO_B.TTF": ("roboto-condensed", "bold", "Roboto Condensed Bold", False),
    "ROBOTO_R.TTF": ("roboto", "regular", "Roboto Regular", False),
    "ROBOTO_B.TTF": ("roboto", "bold", "Roboto Bold", False),
    "OSWALD_R.TTF": ("oswald", "regular", "Oswald Regular", False),
    "OSWALD_B.TTF": ("oswald", "bold", "Oswald Bold", False),
    "ROBOMO_R.TTF": ("roboto-mono", "regular", "Roboto Mono Regular", False),
    "ROBOMO_B.TTF": ("roboto-mono", "bold", "Roboto Mono Bold", False),
    "PLEXMO_R.TTF": ("ibm-plex-mono", "regular", "IBM Plex Mono Regular", False),
    "PLEXMO_B.TTF": ("ibm-plex-mono", "bold", "IBM Plex Mono Bold", False),
    "ATKINS_R.TTF": ("atkinson-hyperlegible", "regular", "Atkinson Hyperlegible Regular", False),
    "ATKINS_B.TTF": ("atkinson-hyperlegible", "bold", "Atkinson Hyperlegible Bold", False),
    "SRCSAN_R.TTF": ("source-sans-3", "regular", "Source Sans 3 Regular", False),
    "SRCSAN_B.TTF": ("source-sans-3", "bold", "Source Sans 3 Bold", False),
}


def _ttf_for(url: str) -> bytes:
    return b"\x00\x01\x00\x00" + url.encode()


@pytest.fixture
def fake_io(monkeypatch):
    """(fetch, fetched urls, stored objects by key)."""
    fetched: list[str] = []
    stored: dict[str, tuple[bytes, str]] = {}

    async def fetch(url):
        fetched.append(url)
        return _ttf_for(url)

    async def put(key, data, content_type):
        stored[key] = (data, content_type)

    monkeypatch.setattr(font_seed, "put_object", put)
    return fetch, fetched, stored


async def _active(db) -> dict[str, LabelFont]:
    rows = (await db.execute(select(LabelFont).where(LabelFont.deleted_at.is_(None)))
            ).scalars().all()
    return {r.name: r for r in rows}


def test_sources_cover_every_open_file_at_a_pinned_commit():
    open_files = {(slug, weight) for slug, fam in FAMILIES.items() if not fam["resident"]
                  for weight, obj in fam["objects"].items() if obj}
    assert set(font_seed.SOURCES) == open_files
    assert len(font_seed.SOURCES) == 14
    pinned = re.compile(r"https://raw\.githubusercontent\.com/[\w.-]+/[\w.-]+/[0-9a-f]{40}/\S+\.ttf")
    for url in font_seed.SOURCES.values():
        assert pinned.fullmatch(url), url


async def test_seed_creates_fourteen_files_and_the_resident_row(db, fake_io):
    fetch, fetched, stored = fake_io
    created = await font_seed.seed(db, fetch=fetch)

    rows = await _active(db)
    assert {name: (r.family, r.weight, r.display_name, r.resident)
            for name, r in rows.items()} == EXPECTED
    assert sorted(created) == sorted(EXPECTED)
    assert sorted(fetched) == sorted(font_seed.SOURCES.values())

    swiss = rows["TT0003M_.TTF"]
    assert swiss.storage_key is None and swiss.size_bytes == 0 and swiss.source_url is None
    for name, row in rows.items():
        if row.resident:
            continue
        url = font_seed.SOURCES[(row.family, row.weight)]
        assert row.source_url == url
        assert re.fullmatch(r"label-fonts/[0-9a-f-]{36}\.ttf", row.storage_key), name
        assert stored[row.storage_key] == (_ttf_for(url), "font/ttf")
        assert row.size_bytes == len(_ttf_for(url))
        assert row.content_type == "font/ttf"
        assert row.uploaded_by is None
    assert len(stored) == 14

    created_audits = (await db.execute(select(AuditLog.entity_id).where(
        AuditLog.entity_type == "label_font", AuditLog.action == "create"))).scalars().all()
    assert sorted(created_audits) == sorted(str(r.id) for r in rows.values())


async def test_seed_is_idempotent(db, fake_io):
    fetch, fetched, stored = fake_io
    await font_seed.seed(db, fetch=fetch)
    before = {name: (r.id, r.storage_key) for name, r in (await _active(db)).items()}
    fetched.clear()

    assert await font_seed.seed(db, fetch=fetch) == []
    assert fetched == []
    assert len(stored) == 14
    after = {name: (r.id, r.storage_key) for name, r in (await _active(db)).items()}
    assert after == before


async def test_seed_adopts_files_already_in_the_library(db, fake_io):
    """A font uploaded under a builder object name before the seed ran gets
    its family and weight instead of a second download; a Swiss 721 file
    uploaded earlier becomes the resident row and keeps its file."""
    fetch, fetched, _stored = fake_io
    roboto = LabelFont(name="ROBOTO_R.TTF", display_name="roboto.ttf",
                       storage_key="label-fonts/mine.ttf", size_bytes=9)
    swiss = LabelFont(name="TT0003M_.TTF", display_name="tt0003m_.ttf",
                      storage_key="label-fonts/swiss.ttf", size_bytes=7)
    gone = LabelFont(name="OSWALD_R.TTF", display_name="old", storage_key="label-fonts/old.ttf",
                     size_bytes=3, deleted_at=datetime.now(UTC))
    db.add_all([roboto, swiss, gone])
    await db.commit()

    created = await font_seed.seed(db, fetch=fetch)

    assert "ROBOTO_R.TTF" in created and "TT0003M_.TTF" in created
    assert font_seed.SOURCES[("roboto", "regular")] not in fetched
    assert font_seed.SOURCES[("oswald", "regular")] in fetched   # a deleted row doesn't count
    assert len(fetched) == 13
    rows = await _active(db)
    assert len(rows) == 15
    r = rows["ROBOTO_R.TTF"]
    assert (r.id, r.family, r.weight, r.display_name, r.storage_key, r.resident) == (
        roboto.id, "roboto", "regular", "Roboto Regular", "label-fonts/mine.ttf", False)
    s = rows["TT0003M_.TTF"]
    assert (s.id, s.family, s.weight, s.display_name, s.storage_key, s.resident) == (
        swiss.id, "swiss721-cond-bold", "regular", "Swiss 721 Condensed Bold",
        "label-fonts/swiss.ttf", True)


async def test_residents_without_file_lists_the_fileless_resident_row(db, fake_io):
    fetch, _fetched, _stored = fake_io
    assert await font_seed.residents_without_file(db) == []
    await font_seed.seed(db, fetch=fetch)
    assert await font_seed.residents_without_file(db) == ["TT0003M_.TTF"]
    swiss = (await _active(db))["TT0003M_.TTF"]
    swiss.storage_key, swiss.size_bytes = "label-fonts/swiss.ttf", 7
    await db.commit()
    assert await font_seed.residents_without_file(db) == []


async def test_seed_refuses_a_download_that_is_not_truetype(db, fake_io):
    _fetch, _fetched, stored = fake_io

    async def html_page(url):
        return b"<!DOCTYPE html><title>404</title>"

    with pytest.raises(font_seed.FontSeedError, match="not a TrueType font"):
        await font_seed.seed(db, fetch=html_page)
    assert stored == {}
    assert all(r.resident for r in (await _active(db)).values())


async def test_a_failed_row_insert_removes_the_stored_file(db, fake_io, monkeypatch):
    """api-core-4: whatever stops the row after the file is stored (not
    only a name race), the file goes again and the error goes on up."""
    fetch, _fetched, stored = fake_io
    deleted: list[str] = []

    async def delete(key):
        deleted.append(key)
        stored.pop(key, None)

    async def broken(db, font, key):
        if font.resident:
            return await real_create(db, font, key)
        raise RuntimeError("database went away")

    real_create = font_seed._create
    monkeypatch.setattr(font_seed, "delete_object", delete)
    monkeypatch.setattr(font_seed, "_create", broken)
    with pytest.raises(RuntimeError, match="database went away"):
        await font_seed.seed(db, fetch=fetch)
    assert len(deleted) == 1 and stored == {}
    assert all(r.resident for r in (await _active(db)).values())


def _transport(handler):
    import httpx
    return httpx.MockTransport(handler)


async def test_http_fetch_streams_and_stops_past_the_cap():
    """security-5: the download stops as soon as it passes MAX_FONT_BYTES,
    before the whole body is read, and never follows a redirect."""
    import httpx

    sent: list[int] = []

    async def endless():
        while True:
            sent.append(1)
            yield b"\x00" * 65536

    def huge(request):
        return httpx.Response(200, content=endless())

    with pytest.raises(font_seed.FontSeedError, match="larger than"):
        await font_seed.http_fetch("https://raw.githubusercontent.com/x/y.ttf",
                                   transport=_transport(huge))
    assert len(sent) * 65536 <= font_seed.MAX_FONT_BYTES + 2 * 65536

    def moved(request):
        return httpx.Response(302, headers={"location": "https://elsewhere.example/y.ttf"})

    with pytest.raises(font_seed.FontSeedError, match="redirect"):
        await font_seed.http_fetch("https://raw.githubusercontent.com/x/y.ttf",
                                   transport=_transport(moved))

    def ok(request):
        return httpx.Response(200, content=b"\x00\x01\x00\x00font")

    assert await font_seed.http_fetch("https://raw.githubusercontent.com/x/y.ttf",
                                      transport=_transport(ok)) == b"\x00\x01\x00\x00font"
    assert font_seed.FETCH_TIMEOUT.read == 30.0 and font_seed.FETCH_TIMEOUT.connect == 60.0


async def test_an_oversized_download_never_reaches_storage(db, fake_io):
    """security-5 through the seed: the cap stops it before put_object."""
    _fetch, _fetched, stored = fake_io

    async def too_big(url):
        return b"\x00\x01\x00\x00" + b"\x00" * font_seed.MAX_FONT_BYTES

    with pytest.raises(font_seed.FontSeedError, match="larger than"):
        await font_seed.seed(db, fetch=too_big)
    assert stored == {}


def test_cli_seed_label_fonts(monkeypatch):
    """`serversherpa seed-label-fonts` runs the seed and lists what it
    added; a refused download stops it with the failure exit code."""
    from typer.testing import CliRunner

    from serversherpa import cli

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def no_dispose():
        pass

    outcome: list = [["TT0003M_.TTF", "ROBOTO_R.TTF"]]

    async def fake_seed(db):
        if isinstance(outcome[0], Exception):
            raise outcome[0]
        return outcome[0]

    fileless: list[str] = ["TT0003M_.TTF"]

    async def residents_without_file(db):
        return fileless

    monkeypatch.setattr(cli, "get_sessionmaker", lambda: _Session)
    monkeypatch.setattr(cli, "dispose_engine", no_dispose)
    monkeypatch.setattr(font_seed, "seed", fake_seed)
    monkeypatch.setattr(font_seed, "residents_without_file", residents_without_file)

    result = CliRunner().invoke(cli.app, ["seed-label-fonts"])
    assert result.exit_code == 0, result.output
    assert "added ROBOTO_R.TTF" in result.output
    assert "Seeded 2 label font(s)." in result.output
    # contracts-5: the resident row it just made has no file yet
    assert ("Upload Zebra's TT0003M_.TTF on Labels › Printers › Install Fonts"
            in result.output)
    fileless.clear()  # adopted with its file: nothing to remind
    result = CliRunner().invoke(cli.app, ["seed-label-fonts"])
    assert result.exit_code == 0 and "Install Fonts" not in result.output

    outcome[0] = font_seed.FontSeedError("https://x/y.ttf: not a TrueType font")
    result = CliRunner().invoke(cli.app, ["seed-label-fonts"])
    assert result.exit_code == cli.EXIT_FAILED
    assert "not a TrueType font" in result.output
