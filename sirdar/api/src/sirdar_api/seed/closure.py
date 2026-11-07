"""Needed rows: the rows a kept row can't exist without.

A required link is a foreign key whose columns are all NOT NULL; an
optional link (any nullable column) adds nothing, since it comes over
empty when its row isn't kept. Links to or from tables outside the public
schema are deliberately ignored (Seed Data only browses and copies public). From every kept row the closure follows
required links up to the rows they point at, transitively, until nothing
new turns up (so cycles and self-references terminate). An "All rows"
table is complete: nothing is ever added to it, but its rows' own
required links are followed like any kept row's. A needed row in a table
without a primary key can't be named, so the whole table is added and
treated as All rows (reported in added_tables).

Primary keys are tuples of the pk values as text (`col::text`, in
pk-column order), exactly as browse renders them, so a key ticked in the
browser compares equal to one the closure finds. Each round runs one
set-based query per required link with that round's new rows, never one
per row. Table and column names only ever come from the catalog; values
go as bind parameters."""

from dataclasses import dataclass, field
from typing import Literal

import asyncpg

from sirdar_api.seed import SeedError
from sirdar_api.seed.browse import SCHEMA, VALUE_CHARS, Table, _catalog, quote

PK = tuple[str, ...]
Kept = dict[str, "set[PK] | Literal['all']"]


@dataclass(frozen=True)
class ForeignKey:
    table: str
    columns: tuple[str, ...]
    ref_table: str
    ref_columns: tuple[str, ...]
    required: bool


@dataclass(frozen=True)
class Reason:
    table: str
    pk: PK
    needed_by_table: str
    needed_by_pk: PK | None          # None: an All rows table without a primary key
    via_columns: tuple[str, ...]


@dataclass(frozen=True)
class TableReason:
    """A whole table added: a kept row needs one of its rows, and it has no
    primary key to name just that row by."""
    table: str
    needed_by_table: str
    via_columns: tuple[str, ...]


@dataclass
class Closure:
    added: dict[str, set[PK]] = field(default_factory=dict)
    reasons: list[Reason] = field(default_factory=list)
    added_tables: list[TableReason] = field(default_factory=list)


_FK_SQL = """
SELECT cr.relname AS table, pr.relname AS ref_table,
       array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n
             ORDER BY k.o) AS columns,
       array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
             ORDER BY k.o) AS ref_columns,
       (SELECT bool_and(a.attnotnull) FROM unnest(con.conkey) k(n)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS required
FROM pg_constraint con
JOIN pg_class cr ON cr.oid = con.conrelid
JOIN pg_namespace cn ON cn.oid = cr.relnamespace
JOIN pg_class pr ON pr.oid = con.confrelid
JOIN pg_namespace pn ON pn.oid = pr.relnamespace
WHERE con.contype = 'f' AND con.conparentid = 0 AND cn.nspname = $1 AND pn.nspname = $1
ORDER BY cr.relname, con.conname
"""


async def foreign_keys(conn: asyncpg.Connection) -> list[ForeignKey]:
    """Every foreign key between two public tables (as browse lists them)."""
    names = {t.name for t in await _catalog(conn)}
    out = []
    for r in await conn.fetch(_FK_SQL, SCHEMA):
        if r["table"] in names and r["ref_table"] in names:
            out.append(ForeignKey(r["table"], tuple(r["columns"]), r["ref_table"],
                                  tuple(r["ref_columns"]), bool(r["required"])))
    return out


def _ref(name: str) -> str:
    return f"{quote(SCHEMA)}.{quote(name)}"


def _in_keys(alias: str, cols: tuple[str, ...], start: int) -> str:
    """`(alias.c1::text, ...) IN (unnest of text arrays $start...)`."""
    lhs = ", ".join(f"{alias}.{quote(c)}::text" for c in cols)
    arrays = ", ".join(f"${start + i}::text[]" for i in range(len(cols)))
    return f"({lhs}) IN (SELECT * FROM unnest({arrays}))"


def _arrays(keys: set[PK] | list[PK], width: int) -> list[list[str]]:
    """Keys as one text array per pk column (bind parameters for unnest)."""
    return [[k[i] for k in keys] for i in range(width)]


def _from(fk: ForeignKey, child: Table, parent: Table,
          frontier: set[PK] | None) -> tuple[str, list]:
    """`FROM child c JOIN parent p ON <fk> [WHERE <c in frontier>]` and its
    bind parameters (frontier None: every row of child)."""
    join = " AND ".join(f"p.{quote(rc)} = c.{quote(cc)}"
                        for cc, rc in zip(fk.columns, fk.ref_columns, strict=True))
    sql = f"FROM {_ref(child.name)} c JOIN {_ref(parent.name)} p ON {join}"
    if frontier is None:
        return sql, []
    return sql + " WHERE " + _in_keys("c", child.pk, 1), _arrays(frontier, len(child.pk))


async def _step(conn, fk: ForeignKey, child: Table, parent: Table,
                frontier: set[PK] | None) -> list[tuple[PK, PK | None]]:
    """(parent pk, child pk) for each parent row the frontier's rows of
    `child` need through `fk` (one child per parent). frontier None: every
    row of child (an All rows table)."""
    p_keys = [f"p.{quote(c)}" for c in parent.pk]
    c_keys = [f"c.{quote(c)}" for c in (child.pk or ())]
    select = ", ".join([f"{k}::text AS p{i}" for i, k in enumerate(p_keys)]
                       + [f"{k}::text AS c{i}" for i, k in enumerate(c_keys)])
    body, args = _from(fk, child, parent, frontier)
    sql = (f"SELECT DISTINCT ON ({', '.join(p_keys)}) {select} {body} "
           f"ORDER BY {', '.join(p_keys + c_keys)}")
    out = []
    for r in await conn.fetch(sql, *args):
        pk = tuple(r[f"p{i}"] for i in range(len(p_keys)))
        by = tuple(r[f"c{i}"] for i in range(len(c_keys))) if child.pk else None
        out.append((pk, by))
    return out


async def _needs_any(conn, fk: ForeignKey, child: Table, parent: Table,
                     frontier: set[PK] | None) -> bool:
    """Whether any of the frontier's rows of `child` has a parent through `fk`."""
    body, args = _from(fk, child, parent, frontier)
    return bool((await conn.fetch(f"SELECT EXISTS (SELECT 1 {body}) AS hit", *args))[0]["hit"])


async def closure(conn: asyncpg.Connection, kept: Kept) -> Closure:
    """The rows the kept rows need through required links, transitively,
    with why each was added (the first kept or added row found to need it).
    `kept` names catalog tables; "all" marks an All rows table."""
    catalog = {t.name: t for t in await _catalog(conn)}
    for name in kept:
        if name not in catalog:
            raise SeedError("table_not_found")
    links = [fk for fk in await foreign_keys(conn) if fk.required]

    known: dict[str, set[PK]] = {n: set(v) for n, v in kept.items() if v != "all"}
    complete = {n for n, v in kept.items() if v == "all"}
    out = Closure()
    # The rows to follow this round: None stands for a whole All rows table.
    frontier: dict[str, set[PK] | None] = {n: None for n in complete}
    frontier.update({n: set(v) for n, v in known.items() if v})
    while frontier:
        found: dict[str, set[PK]] = {}
        whole: set[str] = set()                        # pk-less tables added this round
        for fk in links:
            if fk.table not in frontier or fk.ref_table in complete:
                continue
            rows = frontier[fk.table]
            if rows is not None and not catalog[fk.table].pk:
                continue                               # no row of it can be named
            child, parent = catalog[fk.table], catalog[fk.ref_table]
            if not parent.pk:
                # Its rows can't be named, so a needed one brings the whole
                # table, which is then followed like an All rows table.
                if await _needs_any(conn, fk, child, parent, rows):
                    complete.add(fk.ref_table)
                    whole.add(fk.ref_table)
                    out.added_tables.append(TableReason(fk.ref_table, fk.table, fk.columns))
                continue
            for pk, by in await _step(conn, fk, child, parent, rows):
                have = known.setdefault(fk.ref_table, set())
                if pk in have:
                    continue
                have.add(pk)
                out.added.setdefault(fk.ref_table, set()).add(pk)
                found.setdefault(fk.ref_table, set()).add(pk)
                out.reasons.append(Reason(fk.ref_table, pk, fk.table, by, fk.columns))
        frontier = {**found, **{n: None for n in whole}}
    return out


# ---- resolve: the API's view of the closure ----------------------------------------

_TEXT_SQL = """
SELECT a.attname FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  AND ty.typcategory = 'S'
ORDER BY a.attnum
"""


async def _present(conn, t: Table, pks: list[PK]) -> set[PK]:
    """Which of `pks` table t has."""
    if not pks:
        return set()
    select = ", ".join(f"c.{quote(c)}::text AS k{i}" for i, c in enumerate(t.pk))
    found = await conn.fetch(f"SELECT {select} FROM {_ref(t.name)} c WHERE "
                             + _in_keys("c", t.pk, 1), *_arrays(pks, len(t.pk)))
    return {tuple(r[f"k{i}"] for i in range(len(t.pk))) for r in found}


async def _labels(conn, t: Table, pks: set[PK], key_cols: set[str]) -> dict[PK, str]:
    """Each row's label: its first text column that isn't a key (pk or a
    link's column), cut like a browse value; its pk text when there's none
    or it's NULL."""
    out = {pk: ", ".join(pk) for pk in pks}
    texts = [r["attname"] for r in await conn.fetch(_TEXT_SQL, SCHEMA, t.name)
             if r["attname"] not in key_cols]
    if not texts or not pks:
        return out
    select = ", ".join(f"c.{quote(c)}::text AS k{i}" for i, c in enumerate(t.pk))
    found = await conn.fetch(
        f"SELECT {select}, left(c.{quote(texts[0])}::text, {VALUE_CHARS}) AS label "
        f"FROM {_ref(t.name)} c WHERE " + _in_keys("c", t.pk, 1),
        *_arrays(list(pks), len(t.pk)))
    for r in found:
        if r["label"] is not None:
            out[tuple(r[f"k{i}"] for i in range(len(t.pk)))] = r["label"]
    return out


def _pk_tuple(t: Table, obj: dict) -> PK:
    """A pk object ({column: text}) as a PK tuple; SeedError bad_pk unless
    it names exactly t's pk columns with values Postgres text can hold."""
    if set(obj) != set(t.pk) or any("\x00" in v for v in obj.values()):
        raise SeedError("bad_pk")
    return tuple(obj[c] for c in t.pk)


def _pk_obj(t: Table, pk: PK | None) -> dict | None:
    return dict(zip(t.pk, pk, strict=True)) if pk is not None else None


async def resolve(conn: asyncpg.Connection, tables: dict[str, dict]) -> dict:
    """{"added", "reasons", "added_tables", "missing", "missing_tables"} for
    a selection {table: {"mode": "rows"|"all", "pks": [pk-object...]}}:
    ticked keys the snapshot doesn't have are missing (all of a table's
    when the table itself is gone, which missing_tables names whatever its
    mode), the rest are kept and their needed rows (or whole pk-less
    tables) added."""
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        catalog = {t.name: t for t in await _catalog(conn)}
        kept: Kept = {}
        missing: dict[str, list[dict]] = {}
        missing_tables: list[str] = []
        for name, sel in tables.items():
            t = catalog.get(name)
            if t is None:
                missing_tables.append(name)
                if sel["pks"]:
                    missing[name] = list(sel["pks"])
                continue
            if sel["mode"] == "all":
                kept[name] = "all"
                continue
            if not t.pk:
                raise SeedError("no_primary_key")
            wanted = [_pk_tuple(t, obj) for obj in sel["pks"]]
            have = await _present(conn, t, wanted)
            kept[name] = have
            gone = [obj for obj, pk in zip(sel["pks"], wanted, strict=True) if pk not in have]
            if gone:
                missing[name] = gone
        result = await closure(conn, kept)

        key_cols: dict[str, set[str]] = {}
        for fk in await foreign_keys(conn):
            key_cols.setdefault(fk.table, set()).update(fk.columns)
        wanted_labels: dict[str, set[PK]] = {}
        for r in result.reasons:
            wanted_labels.setdefault(r.table, set()).add(r.pk)
            if r.needed_by_pk is not None:
                wanted_labels.setdefault(r.needed_by_table, set()).add(r.needed_by_pk)
        labels: dict[tuple[str, PK], str] = {}
        for name, pks in wanted_labels.items():
            t = catalog[name]
            cols = set(t.pk) | key_cols.get(name, set())
            for pk, label in (await _labels(conn, t, pks, cols)).items():
                labels[(name, pk)] = label

    added: dict[str, list[dict]] = {}
    reasons = []
    for r in result.reasons:                       # discovery order
        t, by = catalog[r.table], catalog[r.needed_by_table]
        added.setdefault(r.table, []).append(_pk_obj(t, r.pk))
        reasons.append({
            "table": r.table, "pk": _pk_obj(t, r.pk), "label": labels[(r.table, r.pk)],
            "needed_by_table": r.needed_by_table, "needed_by_pk": _pk_obj(by, r.needed_by_pk),
            "needed_by_label": (labels[(r.needed_by_table, r.needed_by_pk)]
                                if r.needed_by_pk is not None else None),
        })
    added_tables = [{"table": a.table, "needed_by_table": a.needed_by_table,
                     "via_columns": list(a.via_columns)} for a in result.added_tables]
    return {"added": added, "reasons": reasons, "added_tables": added_tables,
            "missing": missing, "missing_tables": missing_tables}
