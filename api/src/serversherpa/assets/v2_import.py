"""Import assets + their catalog models from a legacy BaseCamp V2 pg_dump.

One-shot seeding helper behind `serversherpa import-v2-assets` — NOT the
designed bulk-import feature (that remains a planned, spec'd project). Reads
the dump's COPY blocks directly (no restore needed), maps legacy shapes onto
the V3 schema, and leaves anything unparseable visible instead of dropping it
(raw text appended to the model's knowledge field).

Deliberate mappings, per the assets spec:
- legacy per-asset `status` values are move-pipeline stages; they collapse
  onto the V3 lifecycle vocabulary (see STATUS_MAP).
- legacy `client`/`site` FKs have no V3 counterparts in the dev DB — kept
  only inside source_ref for traceability, columns left NULL.
- weight/dimensions parse into the imperial columns; the metric partners are
  computed by apply_unit_pairs, same as interactive entry.
"""

import os
import re
from datetime import date, datetime
from typing import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.assets.units import apply_unit_pairs
from serversherpa.db.models import Asset, AssetModel, AssetModelAlias

SOURCE_REF = "SS-DB_Backup_20251217_172922"

# legacy pipeline stage -> V3 lifecycle key (status_values record_type 'asset')
STATUS_MAP = {
    "complete": "active", "racked": "active", "re-racked": "active",
    "cabling": "active", "qa": "active",
    "in transit": "in_transit", "on truck": "in_transit",
    "in container": "in_transit", "pack / logistics": "in_transit",
    "loaded": "in_transit",
    "received": "in_storage", "staged": "in_storage",
    "pre-stage": "in_storage", "un-pack": "in_storage",
    "labeled": "in_storage",
    "e-waste": "decommissioned", "historical": "decommissioned",
}

CATEGORY_MAP = {"server": "server", "storage": "storage",
                "network": "network", "power": "power"}

MOUNT_MAP = {"rail": "rails", "rails": "rails", "ears": "ears",
             "shelf": "shelf", "custom": "custom"}

_NUM = r"(\d+(?:\.\d+)?)"


def parse_weight(text: str | None) -> float | None:
    """'95 lbs' / '92lb' / '40' -> pounds. 'kg' marked values convert."""
    if not text:
        return None
    m = re.search(_NUM, text)
    if m is None:
        return None
    value = float(m.group(1))
    if "kg" in text.lower():
        return round(value / 0.453592, 2)
    return value


def parse_ru(text: str | None) -> int | None:
    """'2U' / '2' / '3.3U' -> nearest whole RU."""
    if not text:
        return None
    m = re.search(_NUM, text)
    return round(float(m.group(1))) if m else None


def parse_dims(text: str | None) -> tuple[float, float, float] | None:
    """'3.43x17.61x32.32' / '17.08" x 3.4" x 35.3"' -> three inches values,
    legacy positional order preserved."""
    if not text:
        return None
    nums = re.findall(_NUM, text)
    if len(nums) != 3:
        return None
    return (float(nums[0]), float(nums[1]), float(nums[2]))


def map_status(legacy_name: str | None) -> str:
    if not legacy_name:
        return "unknown"
    return STATUS_MAP.get(legacy_name.strip().lower(), "unknown")


def map_category(text: str | None) -> str | None:
    if not text:
        return None
    return CATEGORY_MAP.get(text.strip().lower(), "other")


def map_mount(text: str | None) -> str | None:
    if not text:
        return None
    return MOUNT_MAP.get(text.strip().lower(), "custom")


def _unescape(field: str) -> str:
    return (field.replace("\\t", "\t").replace("\\n", "\n")
            .replace("\\r", "\r").replace("\\\\", "\\"))


def copy_rows(dump_path: str, table: str) -> Iterator[list[str | None]]:
    """Stream one table's COPY block from a pg_dump plain-format file."""
    marker = f"COPY public.{table} ("
    with open(dump_path, encoding="utf-8", errors="replace") as fh:
        in_block = False
        for line in fh:
            if not in_block:
                if line.startswith(marker):
                    in_block = True
                continue
            if line.rstrip("\n") == "\\.":
                return
            fields = line.rstrip("\n").split("\t")
            yield [None if f == "\\N" else _unescape(f) for f in fields]


def _ts(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _looks_like_junk(serial: str | None, name: str | None) -> bool:
    blob = f"{serial or ''} {name or ''}".lower()
    return "test" in blob or blob.strip() in ("", "ffffff")


def build_model_kwargs(row: list[str | None]) -> dict:
    """assets_make_model COPY row -> AssetModel constructor kwargs."""
    (mid, make, model, weight, ru, dims, mount, rail_type,
     knowledge, category) = row[:10]
    leftovers: list[str] = []
    weight_lbs = parse_weight(weight)
    if weight and weight_lbs is None:
        leftovers.append(f"weight: {weight}")
    parsed_dims = parse_dims(dims)
    if dims and parsed_dims is None:
        leftovers.append(f"dimensions: {dims}")
    mount_mapped = map_mount(mount)
    if mount and mount_mapped == "custom" and mount.strip().lower() != "custom":
        leftovers.append(f"mount: {mount}")
    knowledge_out = (knowledge or "").strip()
    if leftovers:
        note = "[v2 import, unparsed] " + "; ".join(leftovers)
        knowledge_out = f"{knowledge_out}\n{note}".strip()
    kwargs: dict = {
        "make": (make or "").strip(),
        "model": (model or "").strip(),
        "category": map_category(category),
        "ru_size": parse_ru(ru),
        "weight_lbs": weight_lbs,
        "mount_type": mount_mapped,
        "rail_type": (rail_type or "").strip() or None,
        "knowledge": knowledge_out,
        "legacy_id": int(mid) if mid else None,
    }
    if parsed_dims is not None:
        kwargs["length_in"], kwargs["width_in"], kwargs["height_in"] = parsed_dims
    return apply_unit_pairs(kwargs)


async def import_assets(
    db: AsyncSession, dump_path: str, limit: int,
) -> dict:
    """Import up to `limit` real-looking assets (+ referenced models and
    aliases). Skips already-imported legacy_ids and existing (make, model)
    catalog rows, so re-runs are additive, not duplicating."""
    statuses = {row[0]: row[1] for row in copy_rows(dump_path, "status_options")}

    candidates = []
    for row in copy_rows(dump_path, "assets"):
        (aid, serial, name, rfid, make_model, created, updated, last_seen,
         location, status, _damage, _notes, client, has_rails, site) = row[:15]
        if _looks_like_junk(serial, name) or make_model is None:
            continue
        candidates.append({
            "legacy_id": int(aid), "serial_number": serial, "name": name,
            "rfid_tag": rfid, "legacy_model_id": int(make_model),
            "created_at": _ts(created), "updated_at": _ts(updated),
            "last_seen_at": _ts(last_seen),
            "location_detail": (location or "").strip(),
            "status": map_status(statuses.get(status) if status else None),
            "has_rails": None if has_rails is None else has_rails == "t",
            "legacy_client": client, "legacy_site": site,
            "sort_key": updated or created or "",
        })
    candidates.sort(key=lambda c: c["sort_key"], reverse=True)

    already = set(await db.scalars(
        select(Asset.legacy_id).where(Asset.legacy_id.is_not(None))))
    picked = [c for c in candidates if c["legacy_id"] not in already][:limit]

    needed_model_ids = {c["legacy_model_id"] for c in picked}
    model_rows = [r for r in copy_rows(dump_path, "assets_make_model")
                  if int(r[0]) in needed_model_ids]

    existing = {(m.make.casefold(), m.model.casefold()): m
                for m in await db.scalars(select(AssetModel))}
    legacy_to_model: dict[int, AssetModel] = {}
    models_created = 0
    for row in model_rows:
        kwargs = build_model_kwargs(row)
        key = (kwargs["make"].casefold(), kwargs["model"].casefold())
        if key in existing:
            legacy_to_model[int(row[0])] = existing[key]
            continue
        model = AssetModel(**kwargs)
        db.add(model)
        existing[key] = model
        legacy_to_model[int(row[0])] = model
        models_created += 1
    await db.flush()

    alias_rows = [r for r in copy_rows(dump_path, "assets_make_model_fuzzy")
                  if int(r[1]) in needed_model_ids]
    taken = {a.casefold() for a in await db.scalars(
        select(AssetModelAlias.alias))}
    aliases_created = 0
    for _rid, legacy_model_id, alias in (r[:3] for r in alias_rows):
        if not alias or alias.casefold() in taken:
            continue
        db.add(AssetModelAlias(
            model_id=legacy_to_model[int(legacy_model_id)].id, alias=alias))
        taken.add(alias.casefold())
        aliases_created += 1

    rfid_taken = {t.casefold() for t in await db.scalars(
        select(Asset.rfid_tag).where(Asset.rfid_tag.is_not(None)))}
    assets_created = 0
    for c in picked:
        rfid = c["rfid_tag"]
        if rfid and rfid.casefold() in rfid_taken:
            rfid = None                      # tag already live on another row
        if rfid:
            rfid_taken.add(rfid.casefold())
        db.add(Asset(
            serial_number=c["serial_number"], name=c["name"], rfid_tag=rfid,
            model_id=legacy_to_model[c["legacy_model_id"]].id,
            location_detail=c["location_detail"], status=c["status"],
            has_rails=c["has_rails"], last_seen_at=c["last_seen_at"],
            created_at=c["created_at"], updated_at=c["updated_at"],
            legacy_id=c["legacy_id"], source="import",
            source_ref=f"{SOURCE_REF} client={c['legacy_client'] or '-'} "
                       f"site={c['legacy_site'] or '-'}",
        ))
        assets_created += 1

    return {"assets": assets_created, "models": models_created,
            "aliases": aliases_created,
            "skipped_already_imported": len(candidates) - len(
                [c for c in candidates if c["legacy_id"] not in already])}


async def import_model_catalog(db: AsyncSession, dump_path: str) -> dict:
    """Import the ENTIRE V2 make/model catalog (assets_make_model +
    assets_make_model_fuzzy aliases) from an INSERT-format dump — unlike
    import_assets above, which only brings the models its picked assets
    reference. Every created row gets a provenance note appended to its
    knowledge field. Additive and idempotent: existing legacy_ids and
    (make, model) pairs are mapped, never duplicated or mutated."""
    from serversherpa.sites.v2_import import insert_rows

    note = (f"[imported from V2 {os.path.basename(dump_path)} "
            f"on {date.today().isoformat()}]")

    existing = {(m.make.casefold(), m.model.casefold()): m
                for m in await db.scalars(select(AssetModel))}
    legacy_to_model: dict[int, AssetModel] = {
        m.legacy_id: m for m in existing.values() if m.legacy_id is not None}

    created = existed = merged_duplicates = 0
    for raw in insert_rows(dump_path, "assets_make_model"):
        row = [v if v is None else str(v) for v in raw[:10]]
        legacy_id = int(row[0])
        if legacy_id in legacy_to_model:
            existed += 1
            continue
        kwargs = build_model_kwargs(row)
        key = (kwargs["make"].casefold(), kwargs["model"].casefold())
        if key in existing:                # same catalog entry, other legacy id
            legacy_to_model[legacy_id] = existing[key]
            if existing[key].legacy_id is None:
                existed += 1
            else:
                merged_duplicates += 1
            continue
        kwargs["knowledge"] = f"{kwargs['knowledge']}\n{note}".strip()
        model = AssetModel(**kwargs)
        db.add(model)
        existing[key] = model
        legacy_to_model[legacy_id] = model
        created += 1
    await db.flush()

    taken = {a.casefold() for a in await db.scalars(
        select(AssetModelAlias.alias))}
    aliases_created = aliases_skipped = 0
    for _rid, legacy_model_id, alias in (
            r[:3] for r in insert_rows(dump_path, "assets_make_model_fuzzy")):
        model = legacy_to_model.get(int(legacy_model_id))
        if not alias or model is None or alias.casefold() in taken:
            aliases_skipped += 1
            continue
        db.add(AssetModelAlias(model_id=model.id, alias=alias))
        taken.add(alias.casefold())
        aliases_created += 1

    return {"models_created": created, "models_existing": existed,
            "duplicates_merged": merged_duplicates,
            "aliases_created": aliases_created,
            "aliases_skipped": aliases_skipped}
