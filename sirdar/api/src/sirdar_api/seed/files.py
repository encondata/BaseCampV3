"""Spaces files that follow a recipe's records. A column holds file keys
when its name says so (the rule scripts/make-sql-seed-snapshot.sh uses):
storage_key, preview_key, avatar_key, logo_key, file_key, or any name
ending in _storage_key.

A file is kept when a kept row (a ticked row, a needed row the closure
adds, or any row of an All rows table) holds its key in such a column, or
when it's ticked by hand; an untick by hand beats both. Only the
snapshot's own objects (objects.tar's members: member name = object key)
are listed, so a key a row names that the bundle doesn't hold is ignored.
Keys and pks compare as text, as browse and closure render them. Table
and column names only ever come from the catalog; values go as bind
parameters.

browse imports file_columns from here, so browse and closure are imported
inside the functions that need them."""

import asyncio
import uuid
from dataclasses import dataclass
from pathlib import Path

FILE_KEY_COLUMNS = frozenset({"storage_key", "preview_key", "avatar_key", "logo_key", "file_key"})
FILE_KEY_SUFFIX = "_storage_key"

PK = tuple[str, ...]
_PHRASES = {"avatar_key": "Avatar of", "logo_key": "Logo of"}
TICKED = "Ticked by hand"
UNTICKED = "Unticked by hand"
NONE = "—"


def file_columns(columns: list[str]) -> list[str]:
    """The names in `columns` that hold file keys, in their order."""
    return [c for c in columns if c in FILE_KEY_COLUMNS or c.endswith(FILE_KEY_SUFFIX)]


@dataclass(frozen=True)
class Reason:
    """The kept row that references a file: its table, pk (None for a table
    without one), label (None likewise) and the column holding the key."""
    table: str
    pk: PK | None
    label: str | None
    column: str


def because(column: str, label: str | None, table: str) -> str:
    """"Avatar of Person A (people)"-style text for a reference."""
    phrase = _PHRASES.get(column, "File on")
    return f"{phrase} {label if label is not None else 'a row'} ({table})"


# ---- kept rows -----------------------------------------------------------------------

async def kept_rows(conn, tables: dict[str, dict]) -> dict:
    """Every kept row of a recipe's selection ({table: {"mode", "pks"}}):
    {table: set of pk tuples | "all"}. Ticked rows the snapshot has, plus
    the closure's needed rows; All rows tables, and the whole pk-less
    tables the closure adds, are "all". Tables the snapshot lacks are left
    out."""
    from sirdar_api.seed import closure
    from sirdar_api.seed.browse import _catalog

    resolved = await closure.resolve(conn, tables)
    catalog = {t.name: t for t in await _catalog(conn)}

    def tup(name: str, obj: dict) -> PK:
        return tuple(obj[c] for c in catalog[name].pk)

    kept: dict = {}
    for name, sel in tables.items():
        if name not in catalog:
            continue
        if sel["mode"] == "all":
            kept[name] = "all"
            continue
        # resolve reports ticked keys the snapshot lacks as missing; they aren't kept.
        gone = {tup(name, o) for o in resolved["missing"].get(name, [])}
        kept[name] = {tup(name, o) for o in sel["pks"]} - gone
    for name, objs in resolved["added"].items():
        if kept.get(name) != "all":
            kept.setdefault(name, set()).update(tup(name, o) for o in objs)
    for a in resolved["added_tables"]:
        kept[a["table"]] = "all"
    return kept


async def referenced(conn, kept_rows: dict) -> dict[str, Reason]:
    """Each storage key the kept rows hold, mapped to the first kept row
    found holding it (tables by name, then file columns in column order,
    then rows in pk order). One query per file column of a kept table."""
    from sirdar_api.seed import SeedError
    from sirdar_api.seed.browse import SCHEMA, _catalog, quote
    from sirdar_api.seed.closure import _arrays, _in_keys, _labels, foreign_keys

    out: dict[str, Reason] = {}
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        catalog = {t.name: t for t in await _catalog(conn)}
        for name in kept_rows:
            if name not in catalog:
                raise SeedError("table_not_found")
        key_cols: dict[str, set[str]] = {}
        for fk in await foreign_keys(conn):
            key_cols.setdefault(fk.table, set()).update(fk.columns)
        found: list[tuple[str, str, PK | None, str]] = []      # key, table, pk, column
        for name in sorted(kept_rows):
            t, rows = catalog[name], kept_rows[name]
            if rows != "all" and (not rows or not t.pk):
                continue
            pk_cols = t.pk or ()
            order = [f"c.{quote(c)}" for c in pk_cols] or ["c.ctid"]
            keys = "".join(f", c.{quote(c)}::text AS k{i}" for i, c in enumerate(pk_cols))
            where, args = "", []
            if rows != "all":
                where = " AND " + _in_keys("c", t.pk, 1)
                args = _arrays(rows, len(t.pk))
            for col in file_columns([c.name for c in t.columns]):
                q = f"c.{quote(col)}::text"
                sql = (f"SELECT DISTINCT ON ({q}) {q} AS key{keys} "
                       f"FROM {quote(SCHEMA)}.{quote(name)} c "
                       f"WHERE c.{quote(col)} IS NOT NULL{where} "
                       f"ORDER BY {q}, {', '.join(order)}")
                for r in await conn.fetch(sql, *args):
                    pk = tuple(r[f"k{i}"] for i in range(len(pk_cols))) if t.pk else None
                    found.append((r["key"], name, pk, col))
        winners: list[tuple[str, str, PK | None, str]] = []
        seen: set[str] = set()
        for key, name, pk, col in found:              # the first row found wins
            if key and key not in seen:
                seen.add(key)
                winners.append((key, name, pk, col))
        wanted: dict[str, set[PK]] = {}
        for _, name, pk, _ in winners:
            if pk is not None:
                wanted.setdefault(name, set()).add(pk)
        labels: dict[tuple[str, PK], str] = {}
        for name, pks in wanted.items():
            t = catalog[name]
            cols = set(t.pk) | key_cols.get(name, set())
            for pk, label in (await _labels(conn, t, pks, cols)).items():
                labels[(name, pk)] = label
    for key, name, pk, col in winners:
        out[key] = Reason(name, pk, labels.get((name, pk)) if pk is not None else None, col)
    return out


# ---- the snapshot's objects ----------------------------------------------------------

def object_keys(bundle_path, max_bytes: int | None = None) -> list[tuple[str, int]]:
    """(key, size) of every object in a bundle's objects.tar, in tar order:
    one streaming pass through the .tar.gz (checksums checked), nothing
    extracted to disk. BundleError for a damaged bundle."""
    import tarfile

    from sirdar_api.deploy import bundle

    out: list[tuple[str, int]] = []

    def on_data(name: str, size: int, reader) -> None:
        if name != bundle.OBJECTS:
            return
        with tarfile.open(fileobj=reader, mode="r|", tarinfo=bundle._SafeInfo) as tar:
            for member in tar:
                if member.isfile():
                    out.append((member.name, member.size))

    bundle._scan(bundle_path, on_data=on_data,
                 max_bytes=max_bytes if max_bytes is not None else bundle.DEFAULT_MAX_BYTES)
    return out


# A snapshot's bundle never changes, so its object list is read once.
_objects: dict[uuid.UUID, list[tuple[str, int]]] = {}
_locks: dict[uuid.UUID, asyncio.Lock] = {}


def forget_objects(snapshot_id: uuid.UUID | None = None) -> None:
    if snapshot_id is None:
        _objects.clear()
    else:
        _objects.pop(snapshot_id, None)


async def objects_for(settings, snap) -> list[tuple[str, int]]:
    """The snapshot's objects sorted by key, read once per snapshot (in a
    thread). SeedError bundle_unreadable when the bundle can't be read."""
    from sirdar_api.deploy import bundle, snapshots
    from sirdar_api.seed import SeedError

    if snap.id in _objects:
        return _objects[snap.id]
    lock = _locks.setdefault(snap.id, asyncio.Lock())
    async with lock:
        if snap.id not in _objects:
            try:
                path = Path(snapshots.bundle_path(settings, snap))
                found = await asyncio.to_thread(object_keys, path,
                                                4 * settings.snapshot_max_bytes)
            except (bundle.BundleError, snapshots.SnapshotError):
                raise SeedError("bundle_unreadable") from None
            _objects[snap.id] = sorted(found)
    return _objects[snap.id]


def listing(objects: list[tuple[str, int]], refs: dict[str, Reason],
            manual: dict[str, bool], *, page: int, size: int, needle: str = "") -> dict:
    """{"files": [{"key","size","kept","because"}], "total"}: a page of
    the objects whose key contains `needle` (case-insensitive)."""
    wanted = needle.casefold()
    matched = [(k, s) for k, s in objects if wanted in k.casefold()] if wanted else objects
    start = (page - 1) * size
    rows = []
    for key, nbytes in matched[start:start + size]:
        ref, hand = refs.get(key), manual.get(key)
        kept = (ref is not None or hand is True) and hand is not False
        if ref is not None and hand is False:
            text = f"{UNTICKED} ({because(ref.column, ref.label, ref.table)})"
        elif not kept:
            text = NONE
        elif ref is not None:
            text = because(ref.column, ref.label, ref.table)
        else:
            text = TICKED
        rows.append({"key": key, "size": nbytes, "kept": kept, "because": text})
    return {"files": rows, "total": len(matched)}
