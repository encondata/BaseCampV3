"""A scan as one JSON document, for the Raw view of an entry on /admin/scans:
every stored field, the names behind its ids, the kiosk's own match, the
matcher's trace (scans/matching.py trace_record, migration 0125) and, for
a processed scan, what it matched and the status rules that ran.

Read-only. A field the scan doesn't have is null, never left out, so two
scans' documents line up when compared."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, Container, Device, Initiative, Person, ProcessedScan, RawScan, Site,
    StatusRuleExecution,
)


# jsonb stores an object's keys re-sorted (shortest first), so the trace is
# put back in reading order: when, what, how, then what came of it.
_TRACE_ORDER = ("attempted_at", "value", "mode", "steps", "outcome", "matched",
                "matched_on", "match_type", "matched_id", "ambiguous_on", "reason",
                "error")
_STEP_ORDER = ("field", "table", "hits", "skipped")


def _in_order(d: dict, order: tuple[str, ...]) -> dict:
    return {**{k: d[k] for k in order if k in d},
            **{k: v for k, v in d.items() if k not in order}}


def _trace(t: dict | None) -> dict | None:
    if t is None:
        return None
    out = _in_order(t, _TRACE_ORDER)
    if isinstance(out.get("steps"), list):
        out["steps"] = [_in_order(s, _STEP_ORDER) if isinstance(s, dict) else s
                        for s in out["steps"]]
    return out


def _person_name(p: Person | None) -> str | None:
    return f"{p.first_name} {p.last_name}" if p is not None else None


async def _named(db: AsyncSession, model, id_: uuid.UUID | None) -> dict | None:
    if id_ is None:
        return None
    row = await db.get(model, id_)
    if row is None:
        return {"id": id_, "name": None, "missing": True}
    name = _person_name(row) if model is Person else row.name
    return {"id": id_, "name": name}


async def _device(db: AsyncSession, device_id: str) -> dict:
    """`device_id` holds what the scan reported: a kiosk's name, a reader's
    name, or "portal". The device row is shown when exactly one has it."""
    rows = (await db.scalars(select(Device).where(Device.name == device_id)
                             .limit(2))).all() if device_id else []
    if len(rows) == 1:
        d = rows[0]
        return {"reported": device_id, "id": d.id, "name": d.name, "serial": d.serial}
    return {"reported": device_id, "id": None, "name": None, "serial": None}


async def _kiosk_match(db: AsyncSession, asset_id: uuid.UUID | None) -> dict | None:
    if asset_id is None:
        return None
    a = await db.get(Asset, asset_id)
    return {"asset_id": asset_id, "name": a.name if a else None,
            "asset_tag": str(a.legacy_id) if a and a.legacy_id is not None else None,
            "missing": a is None}


async def _common(db: AsyncSession, s: RawScan | ProcessedScan) -> dict:
    return {
        "scanned_value": s.scanned_value,
        "scan_type": s.scan_type,
        "scanned_at": s.scanned_at,
        "source": s.source,
        "client_scan_id": s.client_scan_id,
        "device": await _device(db, s.device_id),
        "operator": await _named(db, Person, s.operator_id),
        "site": await _named(db, Site, s.site_id),
        "move": await _named(db, Initiative, s.initiative_id),
        "status": s.status,
        "scan_status": s.scan_status,
        "off_move": s.off_move,
        "location_detail": s.location_detail,
    }


async def raw_scan_record(db: AsyncSession, raw: RawScan) -> dict:
    return {
        "id": raw.id,
        "kind": "raw",
        **await _common(db, raw),
        "created_at": raw.created_at,
        "match_attempted_at": raw.match_attempted_at,
        "kiosk_match": await _kiosk_match(db, raw.kiosk_asset_id),
        "match_trace": _trace(raw.match_trace),
    }


async def _matched(db: AsyncSession, ps: ProcessedScan) -> dict | None:
    if ps.match_type == "asset" and ps.asset_id is not None:
        a = await db.get(Asset, ps.asset_id)
        if a is None:
            return {"id": ps.asset_id, "missing": True}
        return {"id": a.id, "name": a.name,
                "asset_tag": str(a.legacy_id) if a.legacy_id is not None else None,
                "serial_number": a.serial_number, "rfid_tag": a.rfid_tag}
    if ps.match_type == "container" and ps.container_id is not None:
        c = await db.get(Container, ps.container_id)
        return ({"id": c.id, "name": c.name, "rfid_tag": c.rfid_tag} if c
                else {"id": ps.container_id, "missing": True})
    if ps.match_type == "person" and ps.person_id is not None:
        p = await db.get(Person, ps.person_id)
        return ({"id": p.id, "name": _person_name(p), "rfid_tag": p.rfid_tag} if p
                else {"id": ps.person_id, "missing": True})
    return None


async def _rules(db: AsyncSession, ps: ProcessedScan) -> list[dict]:
    """Each status-rule execution for the scan, oldest first. The engine's
    leading {"match": ...} entry is left out of `actions`: `matched` and
    `match_trace` already say it."""
    rows = (await db.scalars(
        select(StatusRuleExecution)
        .where(StatusRuleExecution.processed_scan_id == ps.id)
        .order_by(StatusRuleExecution.id))).all()
    return [{"rule": r.rule_name, "rule_id": r.rule_id,
             "conditions_met": r.conditions_met, "executed_at": r.executed_at,
             "duration_ms": r.duration_ms,
             "actions": [a for a in (r.actions_applied or [])
                         if not (isinstance(a, dict) and "match" in a)],
             "error": r.error}
            for r in rows]


async def processed_scan_record(db: AsyncSession, ps: ProcessedScan) -> dict:
    kiosk = await _kiosk_match(db, ps.kiosk_asset_id)
    if kiosk is not None:
        kiosk["agrees"] = ps.match_type == "asset" and ps.asset_id == ps.kiosk_asset_id
    return {
        "id": ps.id,
        "kind": "processed",
        "raw_scan_id": ps.raw_scan_id,
        **await _common(db, ps),
        "processed_at": ps.processed_at,
        "archived_at": ps.archived_at,
        "match_type": ps.match_type,
        "matched": await _matched(db, ps),
        "kiosk_match": kiosk,
        "match_trace": _trace(ps.match_trace),
        "rules": await _rules(db, ps),
    }
