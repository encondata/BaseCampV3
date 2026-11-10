"""Entity matching for the scan-matching worker. Ladder: ID (uuid or
legacy numeric) → RFID tag → asset serial → name. An RFID read matches
RFID tags only — never an id, serial or name: a zero-padded EPC parses
as a number that can equal another asset's V2 id. Within a tier, tables
are tried in asset → container → person order; the first table with
hits decides. Multiple hits anywhere = ambiguous — the ladder STOPS and
returns None (the value clearly refers to something; guessing or
falling through would mis-attribute the scan). Archived entities are
excluded everywhere. Identifier columns are CITEXT (case-insensitive,
index-backed) EXCEPT people.rfid_tag, which is plain Text — that
comparison is folded to lowercase explicitly in code instead.

`match_scan` can record each lookup into a `trace` list (and say why it
skipped one); `trace_record` turns that into the JSON the worker saves on
the scan (raw_scans/processed_scans.match_trace, migration 0125) for the
Raw view on /admin/scans."""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, Container, Person

_TABLES = {"asset": "assets", "container": "containers", "person": "people"}
_FIELD_LABELS = {"id": "ID", "legacy_id": "Asset ID", "rfid_tag": "RFID tag",
                 "serial_number": "serial number", "name": "name"}


def _step(trace: list | None, field: str, match_type: str, ids: list) -> None:
    """One lookup: how many unarchived rows of `match_type` have the value
    in `field`. The query stops at two, so "2+" means two or more."""
    if trace is not None:
        trace.append({"field": field, "table": _TABLES[match_type],
                      "hits": len(ids) if len(ids) < 2 else "2+"})


def _skip(trace: list | None, field: str, why: str) -> None:
    if trace is not None:
        trace.append({"field": field, "skipped": why})


@dataclass(frozen=True)
class Match:
    match_type: str          # 'asset' | 'container' | 'person'
    target_id: uuid.UUID
    matched_on: str          # id | legacy_id | rfid_tag | serial_number | name


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except (ValueError, AttributeError):
        return None


def _as_int(value: str) -> int | None:
    try:
        return int(value.strip())
    except (ValueError, AttributeError):
        return None


async def _hits(db: AsyncSession, model, column, value,
                 *, case_fold: bool = False) -> list[uuid.UUID]:
    """Up to 2 unarchived ids — enough to tell unique from ambiguous.

    `case_fold` compares func.lower(column) == value.lower() instead of
    plain equality. Needed for people.rfid_tag, which (unlike the CITEXT
    columns everywhere else) is a plain Text column with no built-in
    case-insensitivity."""
    predicate = (func.lower(column) == value.lower()) if case_fold else (column == value)
    return (await db.scalars(
        select(model.id).where(predicate,
                               model.archived_at.is_(None)).limit(2))).all()


# (match_type, model, tag column, case_fold) in ladder order for the RFID tier.
_RFID_TIER = (("asset", Asset, Asset.rfid_tag, False),
              ("container", Container, Container.rfid_tag, False),
              ("person", Person, Person.rfid_tag, True))
_NAME_TIER = (("asset", Asset, Asset.name),
              ("container", Container, Container.name))


async def _rfid_tier(db: AsyncSession, scanned_value: str,
                     trace: list | None = None) -> tuple[bool, Match | None]:
    """(True, match) when a tag table has a hit — match None if that table
    has two (ambiguous, stop the ladder); (False, None) when no tag does.
    Partial-unique per table, so the first table with a hit wins."""
    for match_type, model, column, case_fold in _RFID_TIER:
        ids = await _hits(db, model, column, scanned_value, case_fold=case_fold)
        _step(trace, "rfid_tag", match_type, ids)
        if len(ids) == 1:
            return True, Match(match_type, ids[0], "rfid_tag")
        if ids:
            return True, None
    return False, None


async def match_scan(db: AsyncSession, scanned_value: str, *,
                     scan_type: str | None = None,
                     trace: list | None = None) -> Match | None:
    """The match for `scanned_value`, or None (no hit, or ambiguous). Given
    a `trace` list, appends every lookup it made, in order."""
    if scan_type == "rfid":
        return (await _rfid_tier(db, scanned_value, trace))[1]

    # Tier 1: ID — uuid PKs, then V2 numeric asset labels.
    uid = _as_uuid(scanned_value)
    if uid is not None:
        for match_type, model in (("asset", Asset), ("container", Container),
                                  ("person", Person)):
            ids = await _hits(db, model, model.id, uid)
            _step(trace, "id", match_type, ids)
            if ids:
                return Match(match_type, ids[0], "id")
    else:
        _skip(trace, "id", "not a UUID")
    legacy = _as_int(scanned_value)
    if legacy is not None:
        ids = await _hits(db, Asset, Asset.legacy_id, legacy)
        _step(trace, "legacy_id", "asset", ids)
        if len(ids) == 1:
            return Match("asset", ids[0], "legacy_id")
        if ids:
            return None                      # ambiguous — stop the ladder
    else:
        _skip(trace, "legacy_id", "not a whole number")

    # Tier 2: RFID.
    hit, match = await _rfid_tier(db, scanned_value, trace)
    if hit:
        return match

    # Tier 3: asset serial (deliberately non-unique — dupes are ambiguous).
    ids = await _hits(db, Asset, Asset.serial_number, scanned_value)
    _step(trace, "serial_number", "asset", ids)
    if len(ids) == 1:
        return Match("asset", ids[0], "serial_number")
    if ids:
        return None

    # Tier 4: name fallback. No people-by-name — badges are RFID-only.
    for match_type, model, column in _NAME_TIER:
        ids = await _hits(db, model, column, scanned_value)
        _step(trace, "name", match_type, ids)
        if len(ids) == 1:
            return Match(match_type, ids[0], "name")
        if ids:
            return None
    return None


_ARTICLE = {"asset": "an asset", "container": "a container", "person": "a person"}


def trace_record(scanned_value: str, scan_type: str | None, steps: list,
                 match: Match | None, attempted_at: datetime) -> dict:
    """The JSON the worker saves on a scan for one attempt: the value, the
    mode (an RFID read checks RFID tags only), every lookup, and the
    outcome — matched (with the field and record), ambiguous (the lookup
    with two or more hits, where the ladder stopped) or no_match — with a
    plain-language reason."""
    mode = "rfid_tags_only" if scan_type == "rfid" else "full_ladder"
    out: dict = {"attempted_at": attempted_at.isoformat(), "value": scanned_value,
                 "mode": mode, "steps": steps}
    if match is not None:
        out.update(outcome="matched", matched_on=match.matched_on,
                   match_type=match.match_type, matched_id=str(match.target_id),
                   reason=f"Matched {_ARTICLE[match.match_type]} by its "
                          f"{_FIELD_LABELS[match.matched_on]}")
        return out
    crowded = next((s for s in steps if s.get("hits") == "2+"), None)
    if crowded is not None:
        label = _FIELD_LABELS[crowded["field"]]
        out.update(outcome="ambiguous", ambiguous_on=crowded["field"],
                   reason=f"Two or more {crowded['table']} have this {label}; "
                          "the matcher stops rather than guess")
    elif mode == "rfid_tags_only":
        out.update(outcome="no_match",
                   reason="No asset, container or person has this RFID tag "
                          "(an RFID read checks RFID tags only)")
    else:
        out.update(outcome="no_match",
                   reason="Nothing has this value as an ID, Asset ID, RFID tag, "
                          "serial number or name")
    return out
