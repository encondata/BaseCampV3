"""Raw scans, queried in the database: keyset-paged rows, column facets and
a streamed CSV export, all sharing one filter/search/sort definition.

The portal's Raw scans list filters, searches and sorts on the text a cell
*shows* (scan type and status labels, operator and site names, "—" for an
empty cell), so every column key maps to a SQL expression for that text and
the label/name lookups are LEFT JOINs. Nothing here mutates anything.

Column keys: primary (the scanned value), scan_type, status, device,
operator, site, location, source, plus the two dates, scanned and ingested.
The dates are not text-filterable: `scanned` narrows through since/until and
`ingested` is sort-only.

Sorting is ORDER BY <expression> [natural collation], id — id breaks ties so
the order is total, and the keyset cursor carries the last row's sort value
and id. Empty cells sort as the empty string (first ascending), like the
list always did; the "—" placeholder is only for filters, facets and
display.
"""

import base64
import binascii
import csv
import io
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    Text, and_, case, cast, func, literal_column, or_, select, tuple_,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import ColumnElement

from serversherpa.api.schemas import RawScanItem
from serversherpa.db.models import Person, RawScan, Site, StatusValue
from serversherpa.db.ordering import natural
from serversherpa.imports.bulk import guard_cell

FALLBACK_COLOR = "#51606f"
DASH = "—"

TEXT_COLUMNS = ("primary", "scan_type", "status", "device", "operator",
                "site", "location", "source")
DATE_COLUMNS = ("scanned", "ingested")
SORT_COLUMNS = TEXT_COLUMNS + DATE_COLUMNS

FACET_CAP = 500
MAX_FILTER_VALUES = 1000        # a facet list is capped at FACET_CAP
MAX_FILTER_TEXT = 500

EXPORT_COLUMNS: list[tuple[str, str]] = [
    ("Scanned at", "scanned_at"), ("Value", "scanned_value"),
    ("Scan status", "status_label"), ("Method", "scan_type_label"),
    ("Device", "device_id"), ("Operator", "operator_name"),
    ("Site", "site_name"), ("Location", "location_detail"),
    ("Source", "source"), ("Ingested", "created_at"),
]


class RawQueryError(Exception):
    """A request the query layer refuses; `code` goes into the 422 body."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ── the FROM clause and the per-column expressions ──────────────────────

_ST = aliased(StatusValue)      # scan type vocabulary row
_SV = aliased(StatusValue)      # asset-status vocabulary row (scan status)
_OP = aliased(Person)           # operator
_SI = aliased(Site)             # site
_SPACE = literal_column("' '", type_=Text)


def _joined(stmt):
    return (stmt.select_from(RawScan)
            .outerjoin(_ST, and_(_ST.record_type == RawScan.scan_type_record_type,
                                 _ST.key == RawScan.scan_type))
            .outerjoin(_SV, and_(_SV.record_type == RawScan.status_record_type,
                                 _SV.key == RawScan.status))
            .outerjoin(_OP, _OP.id == RawScan.operator_id)
            .outerjoin(_SI, _SI.id == RawScan.site_id))


# What each text column shows, before the "—" placeholder ('' when empty).
_RAW: dict[str, ColumnElement] = {
    "primary": cast(RawScan.scanned_value, Text),
    "scan_type": func.coalesce(_ST.label, RawScan.scan_type),
    "status": func.coalesce(_SV.label, RawScan.status, literal_column("''")),
    "device": RawScan.device_id,
    "operator": func.coalesce(_OP.first_name + _SPACE + _OP.last_name,
                              literal_column("''")),
    "site": func.coalesce(cast(_SI.name, Text), literal_column("''")),
    "location": RawScan.location_detail,
    "source": RawScan.source,
}


def _display(key: str) -> ColumnElement:
    """The text the cell shows: the value, or "—" when it is empty. (The
    scanned value is shown as-is, never "—".) literal_column keeps the
    constants identical in SELECT, WHERE and GROUP BY so Postgres can match
    the expressions."""
    raw = _RAW[key]
    if key == "primary":
        return raw
    return func.coalesce(func.nullif(raw, literal_column("''")),
                         literal_column(f"'{DASH}'"))


def _sort_expr(key: str) -> ColumnElement:
    if key == "scanned":
        return RawScan.scanned_at
    if key == "ingested":
        return RawScan.created_at
    return natural(_RAW[key])


def _raw_sort_value(key: str) -> ColumnElement:
    if key == "scanned":
        return RawScan.scanned_at
    if key == "ingested":
        return RawScan.created_at
    return _RAW[key]


# ── request parameters ──────────────────────────────────────────────────

@dataclass(frozen=True)
class ColumnFilter:
    text: str = ""
    values: tuple[str, ...] = ()


@dataclass(frozen=True)
class RawScanQuery:
    q: str = ""
    filters: dict[str, ColumnFilter] = field(default_factory=dict)
    since: datetime | None = None
    until: datetime | None = None


def parse_filters(raw: str | None) -> dict[str, ColumnFilter]:
    """The portal's ColumnFilters as JSON: {colKey: {text?, values?}}.

    A saved filter on `scanned`/`ingested` is dropped rather than refused:
    those columns no longer filter by text (the date range does that), and
    a stale saved preference must not turn the whole list into a 422."""
    if raw is None or raw.strip() == "":
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        raise RawQueryError("invalid_filters") from None
    if not isinstance(data, dict):
        raise RawQueryError("invalid_filters")
    out: dict[str, ColumnFilter] = {}
    for key, spec in data.items():
        if key not in SORT_COLUMNS or not isinstance(spec, dict):
            raise RawQueryError("invalid_filters")
        if set(spec) - {"text", "values"}:
            raise RawQueryError("invalid_filters")
        text = spec.get("text", "")
        values = spec.get("values", [])
        if text is None:
            text = ""
        if values is None:
            values = []
        if (not isinstance(text, str) or len(text) > MAX_FILTER_TEXT
                or not isinstance(values, list)
                or len(values) > MAX_FILTER_VALUES
                or not all(isinstance(v, str) for v in values)):
            raise RawQueryError("invalid_filters")
        if key in DATE_COLUMNS:
            continue
        if text or values:
            out[key] = ColumnFilter(text=text, values=tuple(values))
    return out


def _conditions(query: RawScanQuery, skip: str | None = None) -> list[ColumnElement]:
    conds: list[ColumnElement] = []
    q = query.q.strip()
    if q:
        haystack = func.concat_ws(
            literal_column("' '"),
            *(func.nullif(_RAW[k], literal_column("''")) for k in TEXT_COLUMNS))
        conds.append(haystack.icontains(q, autoescape=True))
    for key, f in query.filters.items():
        if key == skip:
            continue
        shown = _display(key)
        if f.text:
            conds.append(shown.icontains(f.text, autoescape=True))
        if f.values:
            conds.append(shown.in_(f.values))
    if query.since is not None:
        conds.append(RawScan.scanned_at >= query.since)
    if query.until is not None:
        conds.append(RawScan.scanned_at <= query.until)
    return conds


# ── cursor ──────────────────────────────────────────────────────────────

def encode_cursor(sort: str, direction: str, value: Any, row_id: int) -> str:
    if isinstance(value, datetime):
        value = value.astimezone(UTC).isoformat()
    payload = json.dumps({"s": sort, "d": direction, "v": value, "i": row_id},
                         separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_cursor(cursor: str, sort: str, direction: str) -> tuple[Any, int]:
    """(sort value, id) of the last row of the previous page. A cursor made
    for another sort or direction is refused: its value means something else."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if (not isinstance(data, dict) or data.get("s") != sort
                or data.get("d") != direction):
            raise ValueError
        value, row_id = data["v"], data["i"]
        if not isinstance(row_id, int) or isinstance(row_id, bool):
            raise TypeError
        if sort in DATE_COLUMNS:
            if not isinstance(value, str):
                raise TypeError
            value = datetime.fromisoformat(value)
            if value.tzinfo is None:
                raise ValueError
        elif not isinstance(value, str):
            raise TypeError
    except (ValueError, KeyError, TypeError, binascii.Error):
        raise RawQueryError("invalid_cursor") from None
    return value, row_id


# ── rows ────────────────────────────────────────────────────────────────

def _row_columns() -> list:
    return [
        RawScan.id.label("id"),
        cast(RawScan.scanned_value, Text).label("scanned_value"),
        RawScan.scan_type.label("scan_type"),
        func.coalesce(_ST.label, RawScan.scan_type).label("scan_type_label"),
        func.coalesce(_ST.color, literal_column(f"'{FALLBACK_COLOR}'"))
        .label("scan_type_color"),
        RawScan.status.label("status"),
        func.coalesce(_SV.label, RawScan.status).label("status_label"),
        case((RawScan.status.is_(None), None),
             else_=func.coalesce(_SV.color, literal_column(f"'{FALLBACK_COLOR}'")))
        .label("status_color"),
        RawScan.scanned_at.label("scanned_at"),
        RawScan.device_id.label("device_id"),
        RawScan.operator_id.label("operator_id"),
        (_OP.first_name + _SPACE + _OP.last_name)
        .label("operator_name"),
        RawScan.site_id.label("site_id"),
        cast(_SI.name, Text).label("site_name"),
        RawScan.location_detail.label("location_detail"),
        RawScan.source.label("source"),
        RawScan.created_at.label("created_at"),
    ]


def _ordered(direction: str, sort: str):
    sort_expr = _sort_expr(sort)
    if direction == "desc":
        return [sort_expr.desc(), RawScan.id.desc()]
    return [sort_expr.asc(), RawScan.id.asc()]


async def page(db: AsyncSession, query: RawScanQuery, *, sort: str,
               direction: str, limit: int, cursor: str | None,
               ) -> tuple[list[RawScanItem], str | None, int]:
    """One page of matching rows, the cursor for the next, and the total
    number of matching rows (every page, not only this one)."""
    conds = _conditions(query)
    total = await db.scalar(_joined(select(func.count())).where(*conds))

    stmt = _joined(select(*_row_columns(),
                          _raw_sort_value(sort).label("_sort_value")))
    after = list(conds)
    if cursor is not None:
        value, last_id = decode_cursor(cursor, sort, direction)
        expr = _sort_expr(sort)
        if sort in DATE_COLUMNS:
            # a row comparison lets Postgres start inside the (date, id) index
            here, there = tuple_(expr, RawScan.id), tuple_(value, last_id)
            after.append(here < there if direction == "desc" else here > there)
        elif direction == "desc":
            after.append(or_(expr < value,
                             and_(expr == value, RawScan.id < last_id)))
        else:
            after.append(or_(expr > value,
                             and_(expr == value, RawScan.id > last_id)))
    stmt = stmt.where(*after).order_by(*_ordered(direction, sort)).limit(limit + 1)

    fetched = (await db.execute(stmt)).all()
    more = len(fetched) > limit
    fetched = fetched[:limit]
    items = [_item(r) for r in fetched]
    next_cursor = None
    if more and fetched:
        last = fetched[-1]
        next_cursor = encode_cursor(sort, direction, last._sort_value, last.id)
    return items, next_cursor, total or 0


def _item(row) -> RawScanItem:
    data = {k: v for k, v in row._mapping.items() if k != "_sort_value"}
    return RawScanItem(**data)


# ── facets ──────────────────────────────────────────────────────────────

async def facets(db: AsyncSession, query: RawScanQuery, column: str,
                 search: str = "") -> list[dict[str, Any]]:
    """The column's distinct displayed values with row counts, most frequent
    first, capped. The column's own filter is left out so a value already
    chosen stays on offer; every other filter, the search box and the date
    range narrow it."""
    shown = _display(column)
    conds = _conditions(query, skip=column)
    needle = search.strip()
    if needle:
        conds.append(shown.icontains(needle, autoescape=True))
    stmt = (_joined(select(shown.label("value"), func.count().label("n")))
            .where(*conds).group_by(shown)
            .order_by(func.count().desc(), natural(shown))
            .limit(FACET_CAP))
    return [{"value": v, "count": n} for v, n in (await db.execute(stmt)).all()]


# ── export ──────────────────────────────────────────────────────────────

def _csv_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return guard_cell(str(value))


async def export_csv(db: AsyncSession, query: RawScanQuery, *, sort: str,
                     direction: str) -> AsyncIterator[bytes]:
    """Every matching row in the current sort, as CSV, a chunk at a time."""
    stmt = (_joined(select(*_row_columns()))
            .where(*_conditions(query)).order_by(*_ordered(direction, sort))
            .execution_options(yield_per=1000))

    def chunk(rows: list[list[str]]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf, lineterminator="\n").writerows(rows)
        return buf.getvalue().encode()

    yield chunk([[title for title, _ in EXPORT_COLUMNS]])
    result = await db.stream(stmt)
    async for rows in result.partitions():
        yield chunk([[_csv_text(r._mapping[attr]) for _, attr in EXPORT_COLUMNS]
                     for r in rows])
