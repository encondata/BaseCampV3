"""Move-assets import pipeline (V2 upload-ft parity on the V3 schema).

Pure of HTTP and job-queue concerns: callers hand in parsed rows and
options and get back the report dict that lands in import_jobs.results.
Contains the complete pipeline: row helpers, the shared validate/commit
pipeline (run_import), and the post-commit placement re-check
(serversherpa.racks.recheck).
"""

import json
import logging
import random
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, InitiativeAsset,
)
from serversherpa.racks.recheck import recheck_placement

logger = logging.getLogger(__name__)

PRIORITY_MAX = 30
BATCH_SIZE = 500

ProgressFn = Callable[[int, int, int, int], Awaitable[None]]
CancelledFn = Callable[[], Awaitable[bool]]


def resolve_make_model_for_creation(asset_make: str,
                                    asset_model: str) -> tuple[str, str]:
    """(make, model) to insert into asset_models — ported from V2's
    upload_helpers: single-populated field splits on first space, then a
    duplicated make prefix is stripped from the model (at most twice) so
    Make='Dell' + Model='Dell R640' stores model='R640'. Model exactly
    equal to make is left alone."""
    make = (asset_make or "").strip()
    model = (asset_model or "").strip()
    if not make and model:
        parts = model.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else parts[0]
    elif make and not model:
        parts = make.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else ""
    for _ in range(2):
        if make and model.lower().startswith(make.lower() + " "):
            model = model[len(make) + 1:].strip()
    return make, model


_HEIGHT_TOKEN = re.compile(r"\s+\d+u$", re.IGNORECASE)


def normalize_model_key(text: str) -> str:
    """The lookup key for matching an imported make/model string against
    the catalog. Every word is kept — "(Chassis)" and "(Node)" tell two
    real rows apart — and only the noise that manufactures accidental
    duplicates goes: underscores become spaces, parentheses are dropped,
    a trailing height token such as "4U" is removed, whitespace collapses,
    case folds. Lookup only; stored make and model are never rewritten."""
    s = text.replace("_", " ").replace("(", " ").replace(")", " ")
    s = " ".join(s.split())
    s = _HEIGHT_TOKEN.sub("", s)
    return s.lower()


def generate_serial(asset_name: str) -> str:
    """V2 format: lowercase_name.13_random_digits."""
    digits = "".join(str(random.randint(0, 9)) for _ in range(13))
    return f"{asset_name.strip().lower()}.{digits}"


def _float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_row(n: int, canonical: dict, raw: dict, *,
              generate_serials: bool) -> dict:
    """One spreadsheet row -> typed import row, or an error entry."""
    serial = canonical["serial_number"].strip()
    name_raw = canonical["asset_name"].strip()
    serial_generated = False
    if not serial:
        if generate_serials and name_raw:
            serial = generate_serial(name_raw)
            serial_generated = True
        else:
            message = ("Missing required field: Serial Number"
                       if not generate_serials
                       else "Cannot generate serial: Asset Name is also blank")
            return {"row": n, "serial_number": "", "status": "error",
                    "message": message}
    serial = serial.lower()

    make = canonical["asset_make"].strip()
    model = canonical["asset_model"].strip()
    make_model_str = (f"{make} {model}" if make and model
                      else model or make or None)

    cable_info: dict = {}
    for i in range(1, 7):
        if value := canonical[f"data_{i}"].strip():
            cable_info[f"data_{i}"] = value
    for i in range(1, 3):
        if value := canonical[f"mgmt_{i}"].strip():
            cable_info[f"mgmt_{i}"] = value

    notes: list[str] = []
    priority = canonical["priority"].strip() or None
    if priority and len(priority) > PRIORITY_MAX:
        notes.append(f"Priority truncated to {PRIORITY_MAX} characters")
        priority = priority[:PRIORITY_MAX]

    def _ru(field: str) -> float | None:
        text = canonical[field].strip()
        return _float(text) if text else None

    return {
        "row": n, "status": "ok",
        "serial_number": serial,
        "asset_name": (name_raw or serial).lower(),
        "asset_make": make, "asset_model": model,
        "make_model_str": make_model_str,
        "serial_generated": serial_generated,
        "rfid_tag": canonical["rfid_tag"].strip(),
        "priority_wave": priority,
        "disposition": canonical["disposition"].strip() or None,
        "owner": canonical["owner"].strip() or None,
        "source_pod": canonical["source_pod"].strip() or None,
        "destination_pod": canonical["destination_pod"].strip() or None,
        "source_rack": canonical["source_rack"].strip() or None,
        "source_ru": _ru("source_ru"),
        "source_position": canonical["source_position"].strip() or None,
        "destination_rack": canonical["destination_rack"].strip() or None,
        "destination_ru": _ru("destination_ru"),
        "destination_position":
            canonical["destination_position"].strip() or None,
        "vendor_involved": bool(canonical["vendor_involvement"].strip()),
        "cable_info": cable_info,
        "raw_ft": raw,
        "notes": notes,
    }


class _SimAsset:
    """Stand-in for an Asset that validate mode 'created' — later rows
    with the same serial resolve as existing without any DB write."""

    id = None

    def __init__(self, serial: str) -> None:
        self.serial_number = serial
        self.rfid_tag: str | None = None
        self.pod_number: str | None = None


_SIM_ASSOC = object()   # roster marker for validate-mode attachments


async def _lookups(db: AsyncSession, initiative_id: uuid.UUID,
                   rows: list[dict]) -> tuple[dict, dict, dict, dict, dict]:
    """Batch lookups for the whole file: assets by serial, RFID holders,
    make/model literal + normalized (exact + alias fuzzy), current roster
    rows by serial."""
    serials = list({r["serial_number"] for r in rows})
    assets: dict[str, Asset] = {}
    if serials:
        for a in await db.scalars(
                select(Asset).where(Asset.serial_number.in_(serials))):
            assets[(a.serial_number or "").lower()] = a

    tags = list({r["rfid_tag"] for r in rows if r["rfid_tag"]})
    rfid: dict[str, Asset] = {}
    if tags:
        for a in await db.scalars(
                select(Asset).where(Asset.rfid_tag.in_(tags))):
            rfid[(a.rfid_tag or "").lower()] = a

    # Matching is two-tier. `literal` is keyed on the catalog display name
    # (and on each alias) exactly as it is written, lowercased only; it is
    # unique by DB constraint, so a row that names a catalog entry
    # verbatim ALWAYS matches it. Only the looser normalized tier can be
    # ambiguous: two catalog rows can normalize to the same key ("Shelf
    # 1U" / "Shelf 2U", "Blank / Panel 1U" / "Blank / Panel 2U", "Dell
    # R740 (Chassis)" / "Dell R740 Chassis"). Guessing one would be
    # non-deterministic, so an ambiguous key is dropped from the
    # normalized map entirely and a row that only reaches it falls through
    # to the review / force path. The ORDER BYs only make the scans
    # themselves reproducible.
    literal: dict[str, tuple] = {}
    models: dict[str, tuple] = {}
    ambiguous: set[str] = set()
    for m in await db.scalars(select(AssetModel).order_by(
            AssetModel.make, AssetModel.model, AssetModel.id)):
        display = f"{m.make} {m.model}".strip()
        literal[display.lower()] = (m, "exact", display)
        key = normalize_model_key(display)
        if key in models:
            ambiguous.add(key)
        else:
            models[key] = (m, "exact", display)
    alias_rows = (await db.execute(
        select(AssetModelAlias.alias, AssetModel)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id)
        .order_by(AssetModelAlias.alias, AssetModel.id))).all()
    for alias, m in alias_rows:                # exact wins over alias
        display = f"{m.make} {m.model}".strip()
        literal.setdefault(alias.lower(), (m, "fuzzy", display))
        key = normalize_model_key(alias)
        if key in ambiguous:                   # an alias cannot break the tie
            continue
        prior = models.get(key)
        if prior is None:
            models[key] = (m, "fuzzy", display)
        elif prior[0].id != m.id:
            # The alias normalizes onto another model — an exact row's key
            # or a second alias. Two answers, so the normalized tier has
            # none; both strings still match literally.
            ambiguous.add(key)
    for key in ambiguous:
        models.pop(key, None)
    if ambiguous:
        logger.warning(
            "move-assets import: %d ambiguous make/model key(s) skipped, "
            "rows using them go to review: %s",
            len(ambiguous), ", ".join(sorted(ambiguous)))

    roster: dict[str, object] = {}
    ids = [a.id for a in assets.values()]
    if ids:
        by_id = {a.id: s for s, a in assets.items()}
        for assoc in await db.scalars(select(InitiativeAsset).where(
                InitiativeAsset.initiative_id == initiative_id,
                InitiativeAsset.asset_id.in_(ids))):
            roster[by_id[assoc.asset_id]] = assoc
    return assets, rfid, literal, models, roster


def _apply_row(assoc: InitiativeAsset, r: dict, now: datetime) -> None:
    assoc.priority_wave = r["priority_wave"]
    assoc.disposition = r["disposition"]
    assoc.owner = r["owner"]
    assoc.source_pod = r["source_pod"]
    assoc.destination_pod = r["destination_pod"]
    assoc.source_rack = r["source_rack"]
    assoc.source_ru = (Decimal(str(r["source_ru"]))
                       if r["source_ru"] is not None else None)
    assoc.source_position = r["source_position"]
    assoc.destination_rack = r["destination_rack"]
    assoc.destination_ru = (Decimal(str(r["destination_ru"]))
                            if r["destination_ru"] is not None else None)
    assoc.destination_position = r["destination_position"]
    assoc.cable_info = (json.dumps(r["cable_info"])
                        if r["cable_info"] else None)
    assoc.vendor_involved = r["vendor_involved"]
    assoc.status = "loaded_in_system"   # V2 parity: re-upload resets status
    assoc.raw_ft = r["raw_ft"]
    assoc.updated_at = now


async def run_import(
    db: AsyncSession, *,
    initiative_id: uuid.UUID,
    added_by: uuid.UUID | None,
    rows: list[dict],
    make_model_mode: str = "fuzzy",
    write: bool,
    source_label: str = "",
    progress: ProgressFn | None = None,
    is_cancelled: CancelledFn | None = None,
) -> dict:
    """The shared pipeline. write=False (validate) runs the identical
    decision path with every DB write suppressed — created assets/models
    are simulated in-memory so later rows in the same file resolve exactly
    as they will at commit. write=True commits in BATCH_SIZE batches
    (progress + cancel checks ride the batch boundary), then flags
    destination collisions and writes ONE audit summary row."""
    from serversherpa.services.audit import audit

    ok_rows = [r for r in rows if r["status"] == "ok"]
    assets, rfid_map, literal_map, model_map, roster = await _lookups(
        db, initiative_id, ok_rows)
    force = make_model_mode in ("force", "hybrid")

    details: list[dict] = []
    created = updated = review = errors = processed = 0
    created_models: list[str] = []
    cancelled = False
    now = datetime.now(UTC)
    # Per-run cache for matches found through the RESOLVED display name
    # (see below) — never written into `model_map`, which is the
    # ambiguity-guarded normalized map `_lookups` built. `mm_key` here may
    # be a key `_lookups` deliberately dropped as ambiguous; writing a
    # literal-tier result back into `model_map` under it would re-open that
    # guard for a later row whose string normalizes to the same key but
    # matches nothing literally.
    resolved_cache: dict[str, tuple] = {}

    async def _one_row(r: dict) -> None:
        nonlocal created, updated, review, errors
        if r["status"] == "error":
            errors += 1
            details.append({"row": r["row"],
                            "serial_number": r["serial_number"],
                            "status": "error", "message": r["message"]})
            return

        serial = r["serial_number"]
        notes = list(r["notes"])

        # RFID skip-and-flag: a tag held by a DIFFERENT asset (DB or an
        # earlier row of this file) is not written; the row still imports.
        rfid_to_write = r["rfid_tag"] or None
        if rfid_to_write:
            holder = rfid_map.get(rfid_to_write.lower())
            if holder is not None and \
                    (holder.serial_number or "").lower() != serial:
                notes.append(
                    f"RFID tag '{rfid_to_write}' skipped: already assigned "
                    f"to serial '{holder.serial_number}'")
                rfid_to_write = None

        asset = assets.get(serial)
        asset_created = False
        match_method = "existing_asset" if asset is not None else "none"
        make_model_final = ""

        if asset is None:
            model_obj = None
            if r["make_model_str"]:
                mm_key = normalize_model_key(r["make_model_str"])
                # A verbatim catalog name (or alias) wins outright; the
                # normalized map is the fallback and may have dropped the
                # key as ambiguous. `resolved_cache` holds matches this
                # same run already found through the RESOLVED display name
                # below — checked here, before the guarded normalized map,
                # so a repeat of this row's exact string reuses that result
                # without ever writing back into `model_map`.
                matched = (literal_map.get(r["make_model_str"].lower())
                           or resolved_cache.get(mm_key)
                           or model_map.get(mm_key))
                if matched is None:
                    mk, md = resolve_make_model_for_creation(
                        r["asset_make"], r["asset_model"])
                    resolved_display = f"{mk} {md}".strip()
                    resolved_key = normalize_model_key(resolved_display)
                    matched = (literal_map.get(resolved_display.lower())
                               or model_map.get(resolved_key))
                    if matched is not None:
                        resolved_cache[mm_key] = matched
                if matched is not None:
                    model_obj, match_method, make_model_final = matched
                elif force:
                    note = ("FORCED: hybrid mode creation (fuzzy match not "
                            "found) for move F-T"
                            if make_model_mode == "hybrid"
                            else "FORCED: make model creation for move F-T")
                    make_model_final = resolved_display
                    if write:
                        model_obj = AssetModel(make=mk, model=md,
                                               knowledge=note)
                        db.add(model_obj)
                        await db.flush()
                    match_method = "force_created"
                    model_map[mm_key] = model_map[resolved_key] = (
                        model_obj, "force_created", make_model_final)
                    created_models.append(make_model_final)
                else:
                    review += 1
                    message = (f"Make/Model '{r['make_model_str']}' "
                               "not found — needs review")
                    if notes:
                        message = f"{message}. " + "; ".join(notes)
                    details.append({
                        "row": r["row"], "serial_number": serial,
                        "status": "review",
                        "message": message,
                        "match_method": "review",
                        "serial_generated": r["serial_generated"],
                        "make_model": r["make_model_str"],
                        "suggested_make": mk,
                        "suggested_model": md})
                    return
            if write:
                asset = Asset(
                    serial_number=serial, name=r["asset_name"],
                    rfid_tag=rfid_to_write,
                    pod_number=r["source_pod"],
                    model_id=model_obj.id if model_obj is not None else None,
                    source="import", source_ref=source_label or None,
                    created_by=added_by)
                db.add(asset)
                await db.flush()
            else:
                asset = _SimAsset(serial)
            asset_created = True
            assets[serial] = asset
            if rfid_to_write:
                rfid_map[rfid_to_write.lower()] = asset
        else:
            if rfid_to_write:
                if write:
                    asset.rfid_tag = rfid_to_write
                    asset.updated_at = now
                rfid_map[rfid_to_write.lower()] = asset
            # The import states where the asset is today; a blank cell
            # says nothing and never clears a known pod.
            if write and r["source_pod"] and asset.pod_number != r["source_pod"]:
                asset.pod_number = r["source_pod"]
                asset.updated_at = now

        if serial in roster:
            assoc = roster[serial]
            if write and isinstance(assoc, InitiativeAsset):
                _apply_row(assoc, r, now)
            updated += 1
            status, message = "updated", "Asset updated in move"
        else:
            if write:
                assoc = InitiativeAsset(initiative_id=initiative_id,
                                        asset_id=asset.id,
                                        added_by=added_by)
                _apply_row(assoc, r, now)
                db.add(assoc)
                roster[serial] = assoc
            else:
                roster[serial] = _SIM_ASSOC
            created += 1
            status, message = "created", "Asset added to move"

        if notes:
            message = f"{message}. " + "; ".join(notes)
        details.append({
            "row": r["row"], "serial_number": serial, "status": status,
            "message": message,
            "asset_id": str(asset.id) if getattr(asset, "id", None) else None,
            "asset_created": asset_created,
            "serial_generated": r["serial_generated"],
            "match_method": match_method,
            "make_model_final": make_model_final})

    for r in rows:
        processed += 1
        await _one_row(r)
        if write and processed % BATCH_SIZE == 0:
            if progress is not None:
                await progress(processed, created, updated, errors)
            await db.commit()
            if is_cancelled is not None and await is_cancelled():
                cancelled = True
                break

    summary = {"total_rows": len(rows), "processed_rows": processed,
               "created": created, "updated": updated, "review": review,
               "errors": errors}
    if created_models:
        summary["models_created"] = len(created_models)

    if write and not cancelled:
        placement = await recheck_placement(db, initiative_id)
        summary["collisions_flagged"] = placement["collisions"]
        summary["orphans_flagged"] = placement["orphans"]
        audit(db, actor_id=added_by, entity_type="initiative",
              entity_id=str(initiative_id), action="asset_import",
              changes={**summary, "source": source_label})
    if write:
        if progress is not None:
            await progress(processed, created, updated, errors)
        await db.commit()
    return {"summary": summary, "details": details, "cancelled": cancelled}
