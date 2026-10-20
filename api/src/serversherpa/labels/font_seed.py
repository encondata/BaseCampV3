"""Load the label builder's font families into the font library (spec
§4.4): `serversherpa seed-label-fonts`.

The fourteen open files (Regular and Bold of seven families, all under the
SIL Open Font License or Apache 2.0, so printers may install them and
browsers may load them) download from raw GitHub URLs pinned to a commit,
and are stored the way an upload on Labels → Printers stores them
(`label-fonts/<uuid>.ttf`). Static TTFs come from google/fonts where it
ships them, otherwise from the family's own upstream repository at the
commit google/fonts packaged. Swiss 721 (TT0003M_.TTF) is Zebra's resident
cut: it gets a row with no file (`resident`), never a download.

Idempotent. A family and weight already in the library is left alone,
except that a resident row whose display name isn't its family's label
gets the label (the Swiss row was seeded as "Swiss 721 Condensed Bold"
until 2026-10-20); a file uploaded earlier under a builder object name is
adopted (given its family, weight and display name) instead of downloaded
again. Each font
commits on its own, so a failed download keeps the fonts before it."""

import uuid
from collections.abc import Awaitable, Callable

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelFont
from serversherpa.labels.fonts import FAMILIES
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import delete_object, put_object

# The font library's file rules, shared with the upload route.
MAX_FONT_BYTES = 2 * 1024 * 1024
TRUETYPE_MAGICS = (b"\x00\x01\x00\x00", b"true")
FONT_FIELDS = ["name", "display_name", "storage_key", "size_bytes", "content_type",
               "uploaded_by", "family", "weight", "resident", "source_url"]

_RAW = "https://raw.githubusercontent.com"
# google/fonts before Roboto went variable-only (the parent of 4dd6e2b3,
# 2023-11-06): Roboto and Roboto Condensed 3.005 statics, Apache 2.0.
_ROBOTO = f"{_RAW}/google/fonts/47ea46c388b5e33496168d9fb4e7ffb43e1142f4/apache/roboto/static"
# google/fonts main on 2026-10-20: IBM Plex Mono and Atkinson Hyperlegible statics, OFL.
_GOOGLE = f"{_RAW}/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl"
# The upstream commits google/fonts' METADATA.pb packages from, OFL / Apache 2.0.
_ROBOTO_MONO = f"{_RAW}/googlefonts/RobotoMono/111eb14e367888c9374da4da0b018e72cf8ac46d/fonts/ttf"
_OSWALD = f"{_RAW}/googlefonts/OswaldFont/89795261ac9eeb9aa8cd99f43982c4e4b0e53261/fonts/ttf"
# adobe-fonts/source-sans tag 3.052R (the release build), OFL.
_SOURCE_SANS = f"{_RAW}/adobe-fonts/source-sans/ed1808970eb3c7301c9a523bee26473ba0bb62fa/TTF"

SOURCES: dict[tuple[str, str], str] = {
    ("roboto-condensed", "regular"): f"{_ROBOTO}/RobotoCondensed-Regular.ttf",
    ("roboto-condensed", "bold"): f"{_ROBOTO}/RobotoCondensed-Bold.ttf",
    ("roboto", "regular"): f"{_ROBOTO}/Roboto-Regular.ttf",
    ("roboto", "bold"): f"{_ROBOTO}/Roboto-Bold.ttf",
    ("oswald", "regular"): f"{_OSWALD}/Oswald-Regular.ttf",
    ("oswald", "bold"): f"{_OSWALD}/Oswald-Bold.ttf",
    ("roboto-mono", "regular"): f"{_ROBOTO_MONO}/RobotoMono-Regular.ttf",
    ("roboto-mono", "bold"): f"{_ROBOTO_MONO}/RobotoMono-Bold.ttf",
    ("ibm-plex-mono", "regular"): f"{_GOOGLE}/ibmplexmono/IBMPlexMono-Regular.ttf",
    ("ibm-plex-mono", "bold"): f"{_GOOGLE}/ibmplexmono/IBMPlexMono-Bold.ttf",
    ("atkinson-hyperlegible", "regular"):
        f"{_GOOGLE}/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf",
    ("atkinson-hyperlegible", "bold"):
        f"{_GOOGLE}/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf",
    ("source-sans-3", "regular"): f"{_SOURCE_SANS}/SourceSans3-Regular.ttf",
    ("source-sans-3", "bold"): f"{_SOURCE_SANS}/SourceSans3-Bold.ttf",
}

Fetch = Callable[[str], Awaitable[bytes]]


class FontSeedError(RuntimeError):
    """A download that can't go into the library."""


def new_storage_key() -> str:
    return f"label-fonts/{uuid.uuid4()}.ttf"


def display_name(family: str, weight: str) -> str:
    """"Roboto Bold"; the resident family is just its own label."""
    fam = FAMILIES[family]
    return fam["label"] if fam["resident"] else f"{fam['label']} {weight.capitalize()}"


# 60 s to connect and in all, but no more than 30 s waiting on any read
FETCH_TIMEOUT = httpx.Timeout(60.0, read=30.0)


async def http_fetch(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> bytes:
    """One pinned font file. A pinned raw URL answers directly, so a
    redirect (which could go anywhere) is refused; the body is read in
    chunks and the download stops as soon as it passes MAX_FONT_BYTES.
    `transport` is for tests."""
    try:
        async with (httpx.AsyncClient(follow_redirects=False, timeout=FETCH_TIMEOUT,
                                      transport=transport) as client,
                    client.stream("GET", url) as resp):
            if resp.is_redirect:
                raise FontSeedError(f"{url}: a redirect to {resp.headers.get('location')}; "
                                    "pinned font URLs never redirect")
            resp.raise_for_status()
            data = bytearray()
            async for chunk in resp.aiter_bytes():
                data += chunk
                if len(data) > MAX_FONT_BYTES:
                    raise FontSeedError(f"{url}: larger than {MAX_FONT_BYTES} bytes")
            return bytes(data)
    except httpx.HTTPError as exc:
        raise FontSeedError(f"{url}: {exc}") from exc


async def _active(db: AsyncSession, *conds) -> LabelFont | None:
    return await db.scalar(select(LabelFont).where(LabelFont.deleted_at.is_(None), *conds))


async def residents_without_file(db: AsyncSession) -> list[str]:
    """The resident rows still waiting for their library copy (the builder
    measures the default font from it): their object names."""
    return list((await db.execute(select(LabelFont.name).where(
        LabelFont.deleted_at.is_(None), LabelFont.resident.is_(True),
        LabelFont.storage_key.is_(None)).order_by(LabelFont.name))).scalars())


async def _adopt(db: AsyncSession, font: LabelFont, family: str, weight: str) -> None:
    before = snapshot(font, FONT_FIELDS)
    font.family, font.weight = family, weight
    font.resident = FAMILIES[family]["resident"]
    font.display_name = display_name(family, weight)
    audit(db, actor_id=None, entity_type="label_font", entity_id=str(font.id),
          action="update", changes=diff(before, snapshot(font, FONT_FIELDS)))
    await db.commit()


async def _discard(key: str | None) -> None:
    """Best-effort removal of a stored file no row points at (the error
    that got us here is the one worth reporting)."""
    if not key:
        return
    try:
        await delete_object(key)
    except Exception:
        pass


async def _create(db: AsyncSession, font: LabelFont, key: str | None) -> bool:
    """Insert one row; False when a concurrent seed or upload took the name
    (its stored object, if any, is removed again)."""
    try:
        db.add(font)
        await db.flush()
        audit(db, actor_id=None, entity_type="label_font", entity_id=str(font.id),
              action="create", changes=diff({}, snapshot(font, FONT_FIELDS)))
        await db.commit()
        return True
    except IntegrityError:
        await db.rollback()
        await _discard(key)
        return False


async def seed(db: AsyncSession, *, fetch: Fetch = http_fetch) -> list[str]:
    """Add every builder font the library lacks; the object names of the
    rows created or adopted, in family order."""
    done: list[str] = []
    for family, fam in FAMILIES.items():
        for weight, obj in fam["objects"].items():
            if not obj:
                continue
            have = await _active(db, LabelFont.family == family, LabelFont.weight == weight)
            if have is not None:
                if fam["resident"] and have.display_name != display_name(family, weight):
                    await _adopt(db, have, family, weight)
                    done.append(have.name)
                continue
            existing = await _active(db, LabelFont.name == obj)
            if existing is not None:
                await _adopt(db, existing, family, weight)
                done.append(obj)
                continue
            common = {"name": obj, "display_name": display_name(family, weight),
                      "content_type": "font/ttf", "family": family, "weight": weight}
            if fam["resident"]:
                font = LabelFont(**common, storage_key=None, size_bytes=0, resident=True)
                key = None
            else:
                url = SOURCES[(family, weight)]
                data = await fetch(url)
                if not data.startswith(TRUETYPE_MAGICS):
                    raise FontSeedError(f"{url}: not a TrueType font")
                if len(data) > MAX_FONT_BYTES:
                    raise FontSeedError(f"{url}: larger than {MAX_FONT_BYTES} bytes")
                key = new_storage_key()
                await put_object(key, data, "font/ttf")
                font = LabelFont(**common, storage_key=key, size_bytes=len(data),
                                 resident=False, source_url=url)
            try:
                created = await _create(db, font, key)
            except Exception:
                # the row never landed: nothing else can reach the file
                await db.rollback()
                await _discard(key)
                raise
            if created:
                done.append(obj)
    return done
