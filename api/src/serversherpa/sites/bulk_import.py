"""Sites bulk import: parse (csv/xlsx/json) → validate → preview/commit.
Pure row pipeline; routes stay thin. All-or-nothing semantics live here.

Blank-cell rule: on create rows, blank status/country take the defaults
(active/US); on update rows a blank cell means "no change", never a clear —
the original cell blankness is tracked out-of-band (`_blank`) because the
normalized `data` dict has already had defaults applied by diff time.

Each preview row therefore also carries `cells`: the uploaded cells exactly as
`_cell()` normalized them, before any default was filled in. The commit replays
those cells, never `data` — replaying `data` would turn a blank status/country
into an explicit write.
"""

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Client, Partner, Site, SiteClient, SiteType, StatusValue,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import (      # re-exported for the container
    MAX_BYTES, MAX_ROWS, BulkImportError,    # importer and the route tests
)

COLUMNS = [
    "name", "code", "type", "status", "address_line1", "address_line2",
    "city", "region", "postal_code", "country", "latitude", "longitude",
    "timezone", "dc_provider", "partner", "clients", "notes",
]
SHEET = "Sites"
# template column → Site attribute (identity except type; partner/clients are
# relations, handled separately)
SITE_ATTR = {c: ("site_type" if c == "type" else c) for c in COLUMNS
             if c not in ("partner", "clients")}

SAMPLE_ROWS: list[dict] = [
    {"name": "Example DC West", "code": "DCW", "type": "datacenter",
     "status": "active", "address_line1": "100 Server Way", "address_line2": "",
     "city": "Reno", "region": "NV", "postal_code": "89501", "country": "US",
     "latitude": "39.5296", "longitude": "-119.8138",
     "timezone": "America/Los_Angeles", "dc_provider": "Switch",
     "partner": "", "clients": "Acme Co; Globex", "notes": "Sample row — replace me"},
    {"name": "Example Office", "code": "", "type": "office", "status": "planned",
     "address_line1": "", "address_line2": "", "city": "Zurich", "region": "",
     "postal_code": "", "country": "CH", "latitude": "", "longitude": "",
     "timezone": "Europe/Zurich", "dc_provider": "", "partner": "",
     "clients": "", "notes": ""},
]

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]


# ── parsing / templates (thin wrappers over the shared core) ────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], type_keys: list[str],
                    status_keys: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid type keys", type_keys), ("Valid status keys", status_keys)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(type_keys: list[str], status_keys: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, type_keys, status_keys)


def _coord_text(value) -> str:
    """Plain decimal text. Only a fractional part may lose trailing zeros —
    a whole-degree 40 must not come back as '4'."""
    if value is None:
        return ""
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live site in template shape, so an export re-uploads clean."""
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    partner_names = dict((await db.execute(select(Partner.id, Partner.name))).all())
    clients: dict[uuid.UUID, list[str]] = {}
    for site_id, cname in (await db.execute(
        select(SiteClient.site_id, Client.name)
        .join(Client, Client.id == SiteClient.client_id)
        .order_by(Client.name))).all():
        clients.setdefault(site_id, []).append(cname)
    out = []
    for s in sites:
        out.append({
            "name": s.name, "code": s.code or "", "type": s.site_type or "",
            "status": s.status, "address_line1": s.address_line1 or "",
            "address_line2": s.address_line2 or "", "city": s.city or "",
            "region": s.region or "", "postal_code": s.postal_code or "",
            "country": s.country or "", "latitude": _coord_text(s.latitude),
            "longitude": _coord_text(s.longitude), "timezone": s.timezone or "",
            "dc_provider": s.dc_provider or "",
            "partner": partner_names.get(s.partner_id, "") if s.partner_id else "",
            "clients": "; ".join(clients.get(s.id, [])), "notes": s.notes or "",
        })
    return out


# ── validation + preview ────────────────────────────────────────────

async def _reference_data(db: AsyncSession) -> dict:
    type_keys = {t.key for t in await db.scalars(select(SiteType))}
    status_keys = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "site")))
    partners: dict[str, list[Partner]] = {}
    for p in await db.scalars(select(Partner)):
        partners.setdefault(p.name.lower(), []).append(p)
    clients: dict[str, list[Client]] = {}
    for c in await db.scalars(select(Client)):
        clients.setdefault(c.name.lower(), []).append(c)
    return {"types": type_keys, "statuses": status_keys,
            "partners": partners, "clients": clients}


def _split_clients(cell: str) -> list[str]:
    return [part.strip() for part in cell.split(";") if part.strip()]


_NON_ALNUM = re.compile(r"[^0-9a-z]+")


def normalize_address(text: str) -> str:
    """Match key for address_line1: case, punctuation and spacing noise
    removed so '607 14th St. NW' and '607 14th st nw' meet."""
    return " ".join(_NON_ALNUM.sub(" ", (text or "").lower()).split())


def _coord(value: str, lo: float, hi: float,
           errors: list[str], label: str) -> float | None:
    if value == "":
        return None
    try:
        num = float(value)
    except ValueError:
        errors.append(f"{label} is not a number")
        return None
    if not (lo <= num <= hi):
        errors.append(f"{label} out of range")
        return None
    return num


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]]) -> dict:
    ref = await _reference_data(db)
    names_seen: dict[str, list[int]] = {}
    addrs_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["name"]:
            names_seen.setdefault(row["name"].lower(), []).append(n)
        key = normalize_address(row["address_line1"])
        if key:
            addrs_seen.setdefault(key, []).append(n)

    by_name: dict[str, list[Site]] = {}
    by_addr: dict[str, list[Site]] = {}
    for site in await db.scalars(select(Site).where(Site.archived_at.is_(None))):
        by_name.setdefault(site.name.lower(), []).append(site)
        key = normalize_address(site.address_line1 or "")
        if key:
            by_addr.setdefault(key, []).append(site)

    dup_sites = [s for sites in by_name.values() for s in sites]
    current_clients: dict[uuid.UUID, dict[uuid.UUID, str]] = {}
    partner_names: dict[uuid.UUID, str] = {}
    if dup_sites:
        links = (await db.execute(
            select(SiteClient.site_id, Client.id, Client.name)
            .join(Client, Client.id == SiteClient.client_id)
            .where(SiteClient.site_id.in_([s.id for s in dup_sites])))).all()
        for site_id, client_id, cname in links:
            current_clients.setdefault(site_id, {})[client_id] = cname
        pids = {s.partner_id for s in dup_sites if s.partner_id}
        if pids:
            partner_names = dict((await db.execute(
                select(Partner.id, Partner.name).where(Partner.id.in_(pids))
            )).all())

    pending: list[dict] = []
    for n, row in numbered:
        errors: list[str] = []
        name = row["name"]
        if not name:
            errors.append("name is required")
        elif len(names_seen[name.lower()]) > 1:
            errors.append(f"duplicate name '{name}' within the import")

        addr_key = normalize_address(row["address_line1"])
        if addr_key and len(addrs_seen[addr_key]) > 1:
            errors.append("duplicate address within the import")

        if row["type"] and row["type"] not in ref["types"]:
            errors.append(f"unknown type '{row['type']}'")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")

        lat = _coord(row["latitude"], -90, 90, errors, "latitude")
        lon = _coord(row["longitude"], -180, 180, errors, "longitude")
        if (row["latitude"] == "") != (row["longitude"] == ""):
            errors.append("latitude and longitude must both be set")

        partner_obj: Partner | None = None
        if row["partner"]:
            matches = ref["partners"].get(row["partner"].lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown partner '{row['partner']}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous partner '{row['partner']}'")
            else:
                partner_obj = matches[0]

        client_objs: list[Client] = []
        for cname in _split_clients(row["clients"]):
            matches = ref["clients"].get(cname.lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown client '{cname}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous client '{cname}'")
            else:
                client_objs.append(matches[0])

        blank = {"status": row["status"] == "", "country": row["country"] == ""}
        data = dict(row)
        data["latitude"], data["longitude"] = lat, lon
        data["clients"] = _split_clients(row["clients"])
        if blank["status"]:
            data["status"] = "active"
        if blank["country"]:
            data["country"] = "US"

        name_hits = by_name.get(name.lower(), []) if name else []
        addr_hits = by_addr.get(addr_key, []) if addr_key else []
        target: Site | None = None
        matched_by: str | None = None
        if not errors:
            if len(name_hits) > 1:
                errors.append(f"multiple existing sites named '{name}'")
            elif name_hits:
                target, matched_by = name_hits[0], "name"
                other = sorted(s.name for s in addr_hits if s.id != target.id)
                if len(other) == len(addr_hits) and other:
                    errors.append(f"name matches '{target.name}' but address "
                                  f"matches '{other[0]}'")
            elif len(addr_hits) > 1:
                names = ", ".join(sorted(s.name for s in addr_hits))
                errors.append(f"multiple existing sites at that address: {names}")
            elif addr_hits:
                target, matched_by = addr_hits[0], "address"

        pending.append({"row": n, "cells": dict(row), "name": name,
                        "errors": errors, "data": data, "blank": blank,
                        "target": target, "matched_by": matched_by,
                        "partner_obj": partner_obj, "client_objs": client_objs})

    # two upload rows resolving to the same existing site would apply twice,
    # last write winning silently — both rows are errors instead
    same_target: dict[uuid.UUID, list[dict]] = {}
    for p in pending:
        if not p["errors"] and p["target"] is not None:
            same_target.setdefault(p["target"].id, []).append(p)
    for group in same_target.values():
        if len(group) > 1:
            for p in group:
                p["errors"].append("two rows match the same existing site "
                                   f"'{p['target'].name}'")

    results = []
    for p in pending:
        errors, target = p["errors"], p["target"]
        action, diff_out, site_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            site_id = str(target.id)
            changes = _diff_row(
                target, p["data"], p["blank"], p["partner_obj"],
                p["client_objs"], current_clients.get(target.id, {}),
                partner_names)
            action = "update" if changes else "unchanged"
            diff_out = changes or None

        results.append({"row": p["row"], "name": p["name"] or None,
                        "action": action,
                        "matched_by": p["matched_by"] if action != "error" else None,
                        "matched_name": target.name if target is not None and action != "error" else None,
                        "errors": errors, "diff": diff_out, "site_id": site_id,
                        "cells": p["cells"],
                        "data": p["data"] if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}


def _diff_row(site: Site, data: dict, blank: dict,
              partner_obj: Partner | None, client_objs: list[Client],
              linked: dict, partner_names: dict) -> dict:
    """Changed fields only; blank in the row = no change (the create-only
    status/country defaults in `data` must not read as edits — `blank`
    remembers the original cells)."""
    out: dict = {}
    for col, attr in SITE_ATTR.items():
        raw = data[col]
        if col in ("status", "country") and blank[col]:
            continue
        if col in ("latitude", "longitude"):
            if raw is None:
                continue
            old = getattr(site, attr)
            old = float(old) if old is not None else None
            if old != raw:
                out[col] = {"old": old, "new": raw}
            continue
        if raw == "":
            continue
        old = getattr(site, attr)
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if data["partner"] and partner_obj is not None:
        if site.partner_id != partner_obj.id:
            out["partner"] = {"old": partner_names.get(site.partner_id),
                              "new": partner_obj.name}
    if data["clients"]:
        want = {c.id: c.name for c in client_objs}
        add = sorted(n for i, n in want.items() if i not in linked)
        remove = sorted(n for i, n in linked.items() if i not in want)
        if add or remove:
            out["clients"] = {"add": add, "remove": remove}
    return out


# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, actor_person_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      approved_updates: set[str], source_label: str) -> dict:
    """All-or-nothing: re-validates everything, then commits creates plus
    APPROVED updates in one transaction. Raises rows_invalid (carrying the
    full preview payload) if anything blocks — nothing is written.

    `numbered` must be the ORIGINAL uploaded cells (the preview's `cells`),
    not its normalized `data`: re-previewing `data` would read a filled-in
    status/country default as an explicit edit."""
    from serversherpa.services.audit import audit

    preview = await preview_rows(db, numbered)
    blocked = [r for r in preview["rows"] if r["action"] == "error"]
    unapproved = [r for r in preview["rows"]
                  if r["action"] == "update" and r["site_id"] not in approved_updates]
    if blocked or unapproved or not preview["rows"]:
        for r in unapproved:
            r["errors"] = [*r["errors"], "update not approved"]
            r["action"] = "error"
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    ref = await _reference_data(db)
    created = updated = unchanged = 0
    applied: list[dict] = []
    for r in preview["rows"]:
        data = r["data"]
        if r["action"] == "unchanged":
            unchanged += 1
            applied.append({"row": r["row"], "name": r["name"],
                            "site_id": r["site_id"], "action": "unchanged",
                            "diff": None})
        elif r["action"] == "create":
            site = await _create_site(db, actor_person_id, data, ref)
            created += 1
            applied.append({"row": r["row"], "name": r["name"],
                            "site_id": str(site.id), "action": "created",
                            "diff": None})
        else:
            await _apply_update(db, actor_person_id, r, ref)
            updated += 1
            applied.append({"row": r["row"], "name": r["name"],
                            "site_id": r["site_id"], "action": "updated",
                            "diff": r["diff"]})
    audit(db, actor_id=actor_person_id, entity_type="site_bulk_import",
          entity_id=None, action="bulk_import",
          changes={"created": created, "updated": updated,
                   "unchanged": unchanged, "source": source_label})
    await db.commit()
    return {"created": created, "updated": updated, "unchanged": unchanged,
            "rows": applied}


def _resolve_partner(ref: dict, name: str) -> Partner | None:
    matches = ref["partners"].get(name.lower(), []) if name else []
    return matches[0] if len(matches) == 1 else None


async def _create_site(db: AsyncSession, actor_person_id: uuid.UUID,
                       data: dict, ref: dict) -> Site:
    from serversherpa.services.audit import audit

    fields = {attr: data[col] for col, attr in SITE_ATTR.items()
              if data[col] not in ("", None)}
    partner = _resolve_partner(ref, data["partner"])
    if partner is not None:
        fields["partner_id"] = partner.id
    site = Site(**fields, created_by=actor_person_id)
    db.add(site)
    await db.flush()
    for cname in data["clients"]:
        client = ref["clients"][cname.lower()][0]
        db.add(SiteClient(site_id=site.id, client_id=client.id,
                          linked_by=actor_person_id))
    changes = {key: {"from": None, "to": _audit_value(value)}
               for key, value in fields.items()}
    if data["clients"]:
        changes["clients"] = {"from": [], "to": sorted(data["clients"])}
    audit(db, actor_id=actor_person_id, entity_type="site",
          entity_id=str(site.id), action="create", changes=changes)
    return site


def _audit_value(value: Any) -> Any:
    return str(value) if isinstance(value, uuid.UUID) else value


async def _apply_update(db: AsyncSession, actor_person_id: uuid.UUID,
                        r: dict, ref: dict) -> None:
    from datetime import UTC, datetime

    from serversherpa.services.audit import audit

    site = await db.get(Site, uuid.UUID(r["site_id"]))
    changes: dict = {}
    for col, change in (r["diff"] or {}).items():
        if col == "clients":
            continue
        if col == "partner":
            partner = _resolve_partner(ref, change["new"])
            site.partner_id = partner.id if partner else site.partner_id
            changes["partner"] = {"from": change["old"], "to": change["new"]}
            continue
        setattr(site, SITE_ATTR[col], change["new"])
        changes[col] = {"from": change["old"], "to": change["new"]}
    client_change = (r["diff"] or {}).get("clients")
    if client_change:
        current = set(await db.scalars(select(SiteClient.client_id).where(
            SiteClient.site_id == site.id)))
        want_ids = {ref["clients"][n.lower()][0].id
                    for n in r["data"]["clients"]}
        for client_id in current - want_ids:
            await db.execute(SiteClient.__table__.delete().where(
                SiteClient.site_id == site.id,
                SiteClient.client_id == client_id))
        for client_id in want_ids - current:
            db.add(SiteClient(site_id=site.id, client_id=client_id,
                              linked_by=actor_person_id))
        changes["clients"] = client_change
    site.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_person_id, entity_type="site",
          entity_id=str(site.id), action="update", changes=changes)
