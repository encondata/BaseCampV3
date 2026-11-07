"""Reading a snapshot's browse database: its tables (public schema only,
without alembic_version) and their rows, a page at a time.

Table and column names come from the request, so each one is looked up in
the database's own catalog first and only a name found there is quoted
into SQL; values only ever go as bind parameters. Every read runs in a
read-only transaction. Values are shown as text cut to 200 characters
(bytea as "<n bytes>"); primary keys come back whole, as text, keyed by
column name: a pk object is what Check all and the recipes store."""

from dataclasses import dataclass

import asyncpg

from sirdar_api.seed import SeedError
from sirdar_api.seed.files import file_columns

SCHEMA = "public"
HIDDEN = frozenset({"alembic_version"})   # always copied whole: not data to browse
VALUE_CHARS = 200


@dataclass(frozen=True)
class Column:
    name: str
    type: str
    is_bytea: bool


@dataclass(frozen=True)
class Table:
    name: str
    columns: tuple[Column, ...]
    pk: tuple[str, ...] | None

    def column(self, name: str) -> Column:
        for col in self.columns:
            if col.name == name:
                return col
        raise SeedError("column_not_found")


def quote(name: str) -> str:
    """An identifier, double-quoted (only ever applied to catalog names)."""
    return '"' + name.replace('"', '""') + '"'


def _ref(table: Table) -> str:
    return f"{quote(SCHEMA)}.{quote(table.name)}"


_TABLES_SQL = """
SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND NOT (c.relname = ANY($2::text[]))
  AND ($3::text IS NULL OR c.relname = $3)
"""
_COLUMNS_SQL = """
SELECT a.attrelid AS oid, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
       a.atttypid = 'bytea'::regtype AS is_bytea
FROM pg_attribute a
WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum
"""
_PK_SQL = """
SELECT i.indrelid AS oid, a.attname
FROM pg_index i
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
WHERE i.indisprimary AND i.indrelid = ANY($1::oid[])
ORDER BY i.indrelid, k.ord
"""


async def _catalog(conn: asyncpg.Connection, only: str | None = None) -> list[Table]:
    rels = await conn.fetch(_TABLES_SQL, SCHEMA, list(HIDDEN), only)
    oids = [r["oid"] for r in rels]
    cols: dict[int, list[Column]] = {}
    for r in await conn.fetch(_COLUMNS_SQL, oids):
        cols.setdefault(r["oid"], []).append(Column(r["attname"], r["type"], r["is_bytea"]))
    pks: dict[int, list[str]] = {}
    for r in await conn.fetch(_PK_SQL, oids):
        pks.setdefault(r["oid"], []).append(r["attname"])
    tables = [Table(r["relname"], tuple(cols.get(r["oid"], ())),
                    tuple(pks[r["oid"]]) if r["oid"] in pks else None) for r in rels]
    return sorted(tables, key=lambda t: t.name)


async def table(conn: asyncpg.Connection, name: str) -> Table:
    """Table `name` as the catalog has it; SeedError table_not_found."""
    if "\x00" in name:                        # Postgres text can't hold one
        raise SeedError("table_not_found")
    found = await _catalog(conn, name)
    if not found:
        raise SeedError("table_not_found")
    return found[0]


async def tables(conn: asyncpg.Connection) -> list[dict]:
    """[{"table", "rows", "pk", "file_columns"}] sorted by name."""
    out = []
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        for t in await _catalog(conn):
            rows = await conn.fetchval(f"SELECT count(*) FROM {_ref(t)}")
            out.append({"table": t.name, "rows": rows,
                        "pk": list(t.pk) if t.pk is not None else None,
                        "file_columns": file_columns([c.name for c in t.columns])})
    return out


def _like(needle: str) -> str:
    """A case-insensitive substring pattern: % _ and \\ match themselves."""
    escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _where(t: Table, filter_col: str, needle: str, args: list) -> str:
    """The WHERE clause for a filter (adding its parameter to `args`)."""
    if needle and not filter_col:
        raise SeedError("filter_col_required")
    if not filter_col:
        return ""
    col = t.column(filter_col)
    if not needle:
        return ""
    if "\x00" in needle:
        raise SeedError("bad_filter")
    args.append(_like(needle))
    return f" WHERE {quote(col.name)}::text ILIKE ${len(args)}"


def _pk_order(t: Table) -> list[str]:
    return [quote(c) for c in t.pk] if t.pk else ["ctid"]


async def rows(conn: asyncpg.Connection, name: str, *, page: int = 1, size: int = 50,
               sort: str | None = None, direction: str = "asc", filter_col: str = "",
               needle: str = "") -> dict:
    """{"columns": [{"name","type"}], "rows": [{"pk", "values"}], "total"}."""
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        t = await table(conn, name)
        args: list = []
        where = _where(t, filter_col, needle, args)
        order = _pk_order(t)
        if sort:
            col = t.column(sort)
            order = [f"{quote(col.name)} {'DESC' if direction == 'desc' else 'ASC'}", *order]
        values = [f"octet_length({quote(c.name)}) AS v{i}" if c.is_bytea
                  else f"left({quote(c.name)}::text, {VALUE_CHARS}) AS v{i}"
                  for i, c in enumerate(t.columns)]
        keys = [f"{quote(c)}::text AS k{i}" for i, c in enumerate(t.pk or ())]
        select = ", ".join(values + keys) or "1"
        args += [size, (page - 1) * size]
        sql = (f"SELECT {select} FROM {_ref(t)}{where} ORDER BY {', '.join(order)} "
               f"LIMIT ${len(args) - 1} OFFSET ${len(args)}")
        try:
            found = await conn.fetch(sql, *args)
        except asyncpg.UndefinedFunctionError:   # no ordering for the type (json, xml...)
            raise SeedError("column_not_sortable") from None
        total = await conn.fetchval(f"SELECT count(*) FROM {_ref(t)}{where}", *args[:-2])
    out = []
    for r in found:
        vals = {}
        for i, c in enumerate(t.columns):
            v = r[f"v{i}"]
            vals[c.name] = f"<{v} bytes>" if c.is_bytea and v is not None else v
        pk = {c: r[f"k{i}"] for i, c in enumerate(t.pk)} if t.pk else None
        out.append({"pk": pk, "values": vals})
    return {"columns": [{"name": c.name, "type": c.type} for c in t.columns],
            "rows": out, "total": total}


async def keys(conn: asyncpg.Connection, name: str, *, filter_col: str = "",
               needle: str = "") -> dict:
    """{"pks": [...], "total"}: every matching row's primary key (no cap),
    in key order. SeedError no_primary_key for a table without one."""
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        t = await table(conn, name)
        args: list = []
        where = _where(t, filter_col, needle, args)
        if not t.pk:
            raise SeedError("no_primary_key")
        select = ", ".join(f"{quote(c)}::text AS k{i}" for i, c in enumerate(t.pk))
        found = await conn.fetch(
            f"SELECT {select} FROM {_ref(t)}{where} ORDER BY {', '.join(_pk_order(t))}", *args)
    pks = [{c: r[f"k{i}"] for i, c in enumerate(t.pk)} for r in found]
    return {"pks": pks, "total": len(pks)}
