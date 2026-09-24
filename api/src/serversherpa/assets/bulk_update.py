"""Update assets in bulk: parse (via imports/bulk) → resolve each row to one
live asset and each value to a record → preview with per-row overrides and
skips, plus the template and export in the same layout.

A row finds its asset by `asset_id` (the human Asset ID, `assets.legacy_id`)
or, when that is blank, by `serial_number` among live assets (case-
insensitive). Every other cell is a new value; a blank cell means "no
change" and nothing is ever cleared. Make + model resolve against the
catalog (assets/model_index), client and site against non-archived records
by name, status against active asset statuses by key or label. An unknown
or ambiguous value — or a serial shared by several live assets — leaves the
row in `attention` with candidates until the admin picks one (an override)
or skips the row; anything that cannot be fixed by a pick is an `error`
sentence. Mirrors people/team_bulk.py.

Apply (`apply_job`) runs in the import worker on a queued job: the same
preview with the stored picks, then every approved update in one
transaction — status changes as manual scans through the rules engine,
a placement recheck for each move holding an asset whose model changed."""

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import distinct, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.assets.model_index import ModelIndex, build_model_index, display_name, find_model
from serversherpa.db.models import (
    Asset,
    AssetModel,
    Client,
    ImportJob,
    Initiative,
    InitiativeAsset,
    Site,
    StatusValue,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import BulkImportError
from serversherpa.racks.recheck import recheck_placement
from serversherpa.scans.manual import SOURCE_ASSET_BULK_UPDATE, record_asset_status_edit
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.status_rules.engine import RuleExecutionError

__all__ = ["BulkImportError"]

COLUMNS = [
    "asset_id", "serial_number", "name", "new_serial_number", "rfid_tag",
    "make", "model", "client", "site", "location", "pod", "status", "has_rails",
]
SHEET = "Assets"
MAX_ROWS = 15000
MAX_BYTES = 20 * 1024 * 1024
FIELDS = ("asset", "model", "client", "site", "status")      # override-able
RECORD_TYPE = "asset"
RFID_LENGTH = 24
TRUE_WORDS = {"yes", "y", "true", "1"}
FALSE_WORDS = {"no", "n", "false", "0"}
ACTIONS = ("update", "unchanged", "attention", "error", "skipped")
LISTING_ORDER = {"attention": 0, "error": 1, "update": 2, "skipped": 3}
# free-text template column → Asset attribute, diff key
TEXT_FIELDS = (("name", "name", "name"), ("location", "location_detail", "location"),
               ("pod", "pod_number", "pod"))
# reference template column → Asset foreign-key attribute
REF_FIELDS = {"client": "client_id", "site": "site_id"}
# `changes` carries these ids as strings (JSON-safe); the ORM wants UUIDs
UUID_ATTRS = frozenset({"model_id", "client_id", "site_id"})
KIND = "asset_bulk_update"
PROGRESS_EVERY = 250
MAX_LEGACY_ID = 2**63 - 1      # Postgres bigint upper bound (asyncpg overflows past it)

SAMPLE_ROWS: list[dict] = [
    {**dict.fromkeys(COLUMNS, ""), "asset_id": "100123", "site": "Example DC West",
     "location": "Cage 4, Row B", "status": "racked", "has_rails": "yes"},
    {**dict.fromkeys(COLUMNS, ""), "serial_number": "SN-EXAMPLE-0042",
     "name": "core-sw-01", "make": "Dell", "model": "PowerEdge R740", "pod": "P12"},
]


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


# ── parsing ─────────────────────────────────────────────────────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS, max_rows=MAX_ROWS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET,
                             max_rows=MAX_ROWS, max_bytes=MAX_BYTES)


def normalize_rfid(raw: str) -> str | None:
    """The kiosk's house format (api/routes/kiosk.py normalize_rfid):
    whitespace out (inside too), upper-cased, ASCII alphanumeric, at most
    24 characters, zero-padded on the left to 24. None when invalid."""
    tag = "".join((raw or "").split()).upper()
    if not tag or not tag.isascii() or not tag.isalnum() or len(tag) > RFID_LENGTH:
        return None
    return tag.rjust(RFID_LENGTH, "0")


def _rfid_key(tag: str) -> str:
    """Zero-stripped, upper-cased key so a tag stored unpadded ("100348",
    however the asset page, the V2 import and the roster importer save it)
    and a zero-padded typed tag ("000...100348") are recognized as the same
    physical tag. An all-zero tag strips to "" and is treated as "0"."""
    return tag.upper().lstrip("0") or "0"


def parse_bool(text: str) -> bool | None:
    key = (text or "").strip().lower()
    if key in TRUE_WORDS:
        return True
    if key in FALSE_WORDS:
        return False
    return None


def parse_overrides(raw: Any) -> dict[int, dict[str, str]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise BulkImportError("invalid_overrides")
    out: dict[int, dict[str, str]] = {}
    for key, picks in raw.items():
        try:
            row = int(key)
        except (TypeError, ValueError):
            raise BulkImportError("invalid_overrides") from None
        if (not isinstance(picks, dict)
                or not all(f in FIELDS and isinstance(v, str) and v for f, v in picks.items())):
            raise BulkImportError("invalid_overrides")
        out[row] = dict(picks)
    return out


def parse_row_list(raw: Any, code: str) -> set[int]:
    if raw is None:
        return set()
    if not isinstance(raw, list) or not all(
            isinstance(n, int) and not isinstance(n, bool) for n in raw):
        raise BulkImportError(code)
    return set(raw)


def _asset_number(text: str) -> int | None:
    return int(text) if text.isascii() and text.isdigit() else None


# ── reference data ──────────────────────────────────────────────────

async def load_reference(db: AsyncSession, numbered: list[tuple[int, dict]]) -> dict:
    """Everything preview (and apply) needs, loaded once for the whole file:
    the file's assets by Asset ID (live and archived) and by serial (every
    live asset sharing it), the holders of the file's RFID tags and new
    serials, the model catalog, non-archived clients and sites, active
    asset statuses, and name maps (archived / inactive included) for the
    diff's old values.

    `asset_id` values past Postgres's bigint range are left out of the
    query (asyncpg would overflow on the bind) — they simply match no
    asset, same as any other unknown Asset ID."""
    numbers = {n for _, row in numbered
              if (n := _asset_number(row["asset_id"])) is not None and n <= MAX_LEGACY_ID}
    serials = {row["serial_number"].lower() for _, row in numbered
               if not row["asset_id"] and row["serial_number"]}
    tags = {t for _, row in numbered if (t := normalize_rfid(row["rfid_tag"]))}
    new_serials = {row["new_serial_number"].lower() for _, row in numbered
                   if row["new_serial_number"]}

    by_number: dict[int, Asset] = {}
    if numbers:
        for a in await db.scalars(select(Asset).where(Asset.legacy_id.in_(numbers))):
            by_number[a.legacy_id] = a
    by_serial: dict[str, list[Asset]] = {}
    if serials:
        for a in await db.scalars(
                select(Asset).where(Asset.serial_number.in_(serials),
                                    Asset.archived_at.is_(None))
                .order_by(Asset.legacy_id)):
            by_serial.setdefault((a.serial_number or "").lower(), []).append(a)
    rfid: dict[str, Asset] = {}
    if tags:
        # a physical tag is unique regardless of stored padding: compare by
        # the zero-stripped, upper-cased key on both sides
        keys = {_rfid_key(t) for t in tags}
        for a in await db.scalars(
                select(Asset).where(func.upper(func.ltrim(Asset.rfid_tag, "0")).in_(keys))):
            rfid[_rfid_key(a.rfid_tag or "")] = a
    new_serial_holders: dict[str, Asset] = {}
    if new_serials:
        for a in await db.scalars(
                select(Asset).where(Asset.serial_number.in_(new_serials),
                                    Asset.archived_at.is_(None))):
            new_serial_holders[(a.serial_number or "").lower()] = a

    models = await build_model_index(db)
    all_clients = list(await db.scalars(select(Client).order_by(Client.name)))
    all_sites = list(await db.scalars(select(Site).order_by(Site.name)))
    all_statuses = list(await db.scalars(
        select(StatusValue).where(StatusValue.record_type == RECORD_TYPE)
        .order_by(StatusValue.sort_order, StatusValue.key)))
    clients = [c for c in all_clients if c.archived_at is None]
    sites = [s for s in all_sites if s.archived_at is None]
    statuses = [s for s in all_statuses if s.is_active]

    def index(objs, keys) -> dict[str, list]:
        out: dict[str, list] = {}
        for o in objs:
            for k in {_squash(k) for k in keys(o)}:
                out.setdefault(k, []).append(o)
        return out

    return {
        "by_number": by_number, "by_serial": by_serial, "rfid": rfid,
        "new_serial_holders": new_serial_holders, "models": models,
        "index": {"client": index(clients, lambda c: [c.name]),
                  "site": index(sites, lambda s: [s.name]),
                  "status": index(statuses, lambda s: [s.key, s.label])},
        "by_id": {"client": {str(c.id): c for c in clients},
                  "site": {str(s.id): s for s in sites},
                  "status": {s.key: s for s in statuses},
                  "model": {str(k): m for k, m in models.models.items()}},
        "model_names": {k: display_name(m) for k, m in models.models.items()},
        "client_names": {c.id: c.name for c in all_clients},
        "site_names": {s.id: s.name for s in all_sites},
        "status_labels": {s.key: s.label for s in all_statuses},
    }


def _asset_candidate(ref: dict, a: Asset) -> dict:
    site = ref["site_names"].get(a.site_id) if a.site_id else None
    parts = [a.serial_number, a.name, site]
    return {"id": str(a.id), "label": f"Asset {a.legacy_id}",
            "detail": " · ".join(p for p in parts if p)}


def _candidate(field: str, obj) -> dict:
    if field == "model":
        return {"id": str(obj.id), "label": display_name(obj), "detail": obj.category or ""}
    if field == "status":
        return {"id": obj.key, "label": obj.label, "detail": obj.key}
    return {"id": str(obj.id), "label": obj.name, "detail": ""}


def _stale_pick(field: str, errors: list[str]) -> None:
    errors.append(f"The chosen {field} no longer exists. Pick again.")


def _resolve(ref: dict, field: str, cell: str, picked: str | None,
             issues: list[dict], errors: list[str]):
    """One client / site / status for this cell: the admin's pick wins;
    otherwise exactly one match by name (or status key / label). Unknown /
    ambiguous → an issue with candidates; a pick that points at nothing → an
    error. None when blank or unresolved."""
    if picked:
        obj = ref["by_id"][field].get(picked)
        if obj is None:
            _stale_pick(field, errors)
        return obj
    if not cell:
        return None
    matches = ref["index"][field].get(_squash(cell), [])
    unique = list({id(m): m for m in matches}.values())
    if len(unique) == 1:
        return unique[0]
    issues.append({"field": field, "kind": "ambiguous" if unique else "unknown",
                   "value": cell, "candidates": [_candidate(field, m) for m in unique]})
    return None


def _resolve_model(ref: dict, row: dict, picked: str | None,
                   issues: list[dict], errors: list[str]) -> AssetModel | None:
    if picked:
        obj = ref["by_id"]["model"].get(picked)
        if obj is None:
            _stale_pick("model", errors)
        return obj
    make, model = row["make"], row["model"]
    if not make and not model:
        return None
    if not make or not model:
        errors.append("Fill both make and model, or neither.")
        return None
    index: ModelIndex = ref["models"]
    match, candidates = find_model(index, make, model)
    if match is None:
        issues.append({"field": "model", "kind": "ambiguous" if candidates else "unknown",
                       "value": f"{make} {model}",
                       "candidates": [_candidate("model", m) for m in candidates]})
    return match


def _find_asset(ref: dict, row: dict, picked: str | None, issues: list[dict],
                errors: list[str]) -> tuple[Asset | None, str | None]:
    """(asset, matched_by). Asset ID pins the asset; otherwise the serial
    must name exactly one live asset, or the admin picks among them."""
    if row["asset_id"]:
        number = _asset_number(row["asset_id"])
        if number is None:
            errors.append("Asset ID must be a number.")
            return None, None
        asset = ref["by_number"].get(number)
        if asset is None:
            errors.append(f"No asset with Asset ID {number}.")
            return None, None
        if asset.archived_at is not None:
            errors.append(f"Asset {number} is archived.")
            return None, None
        return asset, "asset ID"
    serial = row["serial_number"]
    if not serial:
        errors.append("Each row needs an asset_id or a serial_number.")
        return None, None
    live = ref["by_serial"].get(serial.lower(), [])
    if picked:
        chosen = next((a for a in live if str(a.id) == picked), None)
        if chosen is None:
            errors.append(f"The chosen asset is no longer a live asset with serial "
                          f"'{serial}'. Pick again.")
            return None, None
        return chosen, "your pick"
    if not live:
        errors.append(f"No live asset with serial '{serial}'.")
        return None, None
    if len(live) == 1:
        return live[0], "serial"
    issues.append({"field": "asset", "kind": "ambiguous", "value": serial,
                   "candidates": [_asset_candidate(ref, a) for a in live]})
    return None, None


def _yes_no(value: bool | None) -> str | None:
    return None if value is None else ("yes" if value else "no")


# ── preview ─────────────────────────────────────────────────────────

def _resolve_row(ref: dict, n: int, row: dict, picks: dict[str, str]) -> dict:
    errors: list[str] = []
    issues: list[dict] = []
    asset, matched_by = _find_asset(ref, row, picks.get("asset"), issues, errors)
    changes: dict[str, Any] = {}
    diff: dict[str, dict] = {}

    def change(attr: str, key: str, value, old_display, new_display) -> None:
        changes[attr] = value
        diff[key] = {"old": old_display, "new": new_display}

    for col, attr, key in TEXT_FIELDS:
        value = row[col]
        if value and asset is not None and (getattr(asset, attr) or "").strip() != value:
            change(attr, key, value, getattr(asset, attr), value)

    new_serial = row["new_serial_number"]
    if new_serial:
        if not row["asset_id"]:
            errors.append("Change the serial only on rows with an asset_id.")
        else:
            holder = ref["new_serial_holders"].get(new_serial.lower())
            if holder is not None and (asset is None or holder.id != asset.id):
                errors.append(f"Serial '{new_serial}' is already on asset {holder.legacy_id}.")
            elif asset is not None and (asset.serial_number or "").strip() != new_serial:
                change("serial_number", "serial_number", new_serial, asset.serial_number,
                       new_serial)

    tag = None
    if row["rfid_tag"]:
        tag = normalize_rfid(row["rfid_tag"])
        if tag is None:
            errors.append(f"RFID tag '{row['rfid_tag']}' is not valid.")
        else:
            holder = ref["rfid"].get(_rfid_key(tag))
            # a row whose asset is still ambiguous (pending a pick) may have
            # its typed tag held by one of its own candidates; don't error
            # against that yet — let the pick decide, then re-check
            candidate_ids = {c["id"] for i in issues if i["field"] == "asset"
                             for c in i["candidates"]}
            if holder is not None and asset is not None and holder.id == asset.id:
                if _rfid_key(asset.rfid_tag or "") != _rfid_key(tag):
                    change("rfid_tag", "rfid_tag", tag, asset.rfid_tag, tag)
            elif holder is not None and asset is None and str(holder.id) in candidate_ids:
                pass
            elif holder is not None:
                errors.append(f"RFID tag {row['rfid_tag']} is already on asset "
                              f"{holder.legacy_id}.")
            elif asset is not None and _rfid_key(asset.rfid_tag or "") != _rfid_key(tag):
                change("rfid_tag", "rfid_tag", tag, asset.rfid_tag, tag)

    model = _resolve_model(ref, row, picks.get("model"), issues, errors)
    if model is not None and asset is not None and asset.model_id != model.id:
        change("model_id", "model", str(model.id), ref["model_names"].get(asset.model_id),
               display_name(model))

    for col, attr in REF_FIELDS.items():
        obj = _resolve(ref, col, row[col], picks.get(col), issues, errors)
        if obj is not None and asset is not None and getattr(asset, attr) != obj.id:
            names = ref[f"{col}_names"]
            change(attr, col, str(obj.id), names.get(getattr(asset, attr)), obj.name)

    status = _resolve(ref, "status", row["status"], picks.get("status"), issues, errors)
    if status is not None and asset is not None and asset.status != status.key:
        change("status", "status", status.key,
               ref["status_labels"].get(asset.status, asset.status), status.label)

    if row["has_rails"]:
        rails = parse_bool(row["has_rails"])
        if rails is None:
            errors.append("has_rails must be yes or no.")
        elif asset is not None and asset.has_rails is not rails:
            change("has_rails", "has_rails", rails, _yes_no(asset.has_rails), _yes_no(rails))

    return {
        "row": n,
        "name": (asset.name or asset.serial_number) if asset is not None
        else (row["serial_number"] or (f"Asset {row['asset_id']}" if row["asset_id"] else None)),
        "asset_id": str(asset.id) if asset is not None else None,
        "asset_number": asset.legacy_id if asset is not None else None,
        "matched_by": matched_by, "errors": errors, "issues": issues,
        "diff": diff, "changes": changes, "rfid": tag,
        "new_serial": new_serial.casefold() if new_serial else None,
        "action": "error" if errors else ("attention" if issues else "pending"),
    }


def _flag_duplicates(rows: list[dict], key: str, sentence) -> None:
    """Every row sharing a `key` value with another row gets an error that
    lists all of their line numbers."""
    seen: dict[Any, list[dict]] = {}
    for r in rows:
        if r.get(key):
            seen.setdefault(r[key], []).append(r)
    for group in seen.values():
        if len(group) > 1:
            lines = ", ".join(str(g["row"]) for g in group)
            for g in group:
                g["errors"].append(sentence(g, lines))
                g["action"] = "error"


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                       overrides: dict[int, dict[str, str]] | None = None,
                       skip: set[int] | None = None, ref: dict | None = None) -> dict:
    """`ref` lets a caller that already loaded the reference data pass it
    in instead of paying for a second load."""
    ref = ref if ref is not None else await load_reference(db, numbered)
    overrides = overrides or {}
    skip = skip or set()
    out: list[dict] = []
    cells = dict(numbered)
    for n, row in numbered:
        if n in skip:
            out.append({"row": n, "name": row["serial_number"] or (
                            f"Asset {row['asset_id']}" if row["asset_id"] else None),
                        "asset_id": None, "asset_number": None, "matched_by": None,
                        "errors": [], "issues": [], "diff": None, "changes": {},
                        "rfid": None, "new_serial": None, "action": "skipped"})
            continue
        out.append(_resolve_row(ref, n, row, overrides.get(n, {})))

    live = [r for r in out if r["action"] != "skipped"]
    _flag_duplicates(live, "asset_id", lambda g, lines: (
        f"Asset {g['asset_number']} appears on more than one row ({lines})."))
    _flag_duplicates(live, "rfid", lambda g, lines: (
        f"RFID tag {cells[g['row']]['rfid_tag']} appears on more than one row ({lines})."))
    _flag_duplicates(live, "new_serial", lambda g, lines: (
        f"Serial '{cells[g['row']]['new_serial_number']}' is set on more than one row "
        f"({lines})."))

    for r in out:
        r.pop("rfid")
        r.pop("new_serial")
        if r["action"] == "pending":
            r["action"] = "update" if r["changes"] else "unchanged"
        if r["action"] != "update":
            r["diff"], r["changes"] = None, {}

    counts = dict.fromkeys(ACTIONS, 0)
    for r in out:
        counts[r["action"]] += 1
    return {"rows": out, "counts": counts,
            "can_commit": bool(out) and counts["attention"] == 0 and counts["error"] == 0}


def listing(preview: dict) -> dict:
    """The API payload: `unchanged` rows are only counted; the rest are
    listed attention first, then errors, updates, skips (by line within
    each)."""
    rows = sorted((r for r in preview["rows"] if r["action"] != "unchanged"),
                  key=lambda r: (LISTING_ORDER[r["action"]], r["row"]))
    return {"rows": rows, "counts": preview["counts"], "can_commit": preview["can_commit"],
            "total": len(preview["rows"])}


# ── apply ───────────────────────────────────────────────────────────

def _invalid_rows(preview: dict) -> list[dict]:
    return [r for r in preview["rows"] if r["action"] in ("attention", "error")]


def _assets_by_id(ref: dict) -> dict[str, Asset]:
    """Every asset `load_reference` found, keyed by id string — reused in
    the write loop below so an approved row never re-queries an asset the
    preview already loaded (a job can have up to 15,000 rows)."""
    out = {str(a.id): a for a in ref["by_number"].values()}
    for group in ref["by_serial"].values():
        for a in group:
            out[str(a.id)] = a
    return out


CONFLICT_MESSAGE = ("Another change to these assets landed while the update was applying. "
                    "Upload the file again to see the current values.")


async def apply_job(db: AsyncSession, job: ImportJob, *,
                    progress: Callable[[int], Awaitable[None]] | None = None) -> None:
    """All-or-nothing apply of a queued job. Re-runs the preview with the
    stored picks and skips; anything needing attention or in error fails
    the job (`rows_invalid`, nothing written). Otherwise writes every
    approved update (`approve_all`, or its row in `approved_updates`) in one
    transaction and commits; unapproved updates are reported as skipped. A
    failing status rule rolls everything back (`rule_failed`), and so does
    a concurrent write landing on one of these assets between the preview
    re-check and the flush (`apply_conflict`).

    `job.results["rows"]` lists only the `updated` and `skipped` rows —
    `unchanged` rows are counted in `job.results["summary"]` only, so a
    15,000-row job with mostly no-op rows doesn't store 15,000 result rows.

    Sets the job's status / error / results itself; the caller commits the
    job row afterwards (a no-op on success, where the job's completion was
    committed with the data). `progress(n)` is awaited every PROGRESS_EVERY
    rows while this transaction is still open, so it must write through
    its own session — and nothing here touches the job row before the
    final commit, so that session never waits on a lock held here. On any
    failure `processed_rows` is reset to 0 so the page never shows partial
    progress next to a failed job."""
    numbered = [(r["row"], r["cells"]) for r in job.payload or []]
    opts = job.options or {}
    overrides = {int(k): v for k, v in (opts.get("overrides") or {}).items()}
    skip = {int(x) for x in opts.get("skip") or []}
    approve_all = bool(opts.get("approve_all"))
    approved = {int(x) for x in opts.get("approved_updates") or []}
    actor = job.created_by

    # loaded once, up front, and kept alive for the whole apply: `preview_rows`
    # reuses it instead of loading its own copy, and the write loop below reads
    # every approved row's asset straight out of it instead of re-querying
    ref = await load_reference(db, numbered)
    assets = _assets_by_id(ref)

    preview = await preview_rows(db, numbered, overrides=overrides, skip=skip, ref=ref)
    if not preview["can_commit"]:
        invalid = _invalid_rows(preview)
        job.status, job.error = "failed", "rows_invalid"
        job.error_count = len(invalid)
        job.results = {"rows": invalid}
        job.processed_rows = 0
        job.finished_at = datetime.now(UTC)
        return

    now = datetime.now(UTC)
    counts = {"updated": 0, "skipped": 0, "unchanged": 0}
    applied: list[dict] = []
    model_changed: set[uuid.UUID] = set()
    row_no = None
    try:
        for i, r in enumerate(preview["rows"], 1):
            row_no = r["row"]
            action = r["action"]
            if action == "update" and (approve_all or row_no in approved):
                asset = assets[r["asset_id"]]
                changes = r["changes"]
                before = snapshot(asset, list(changes))
                for attr, value in changes.items():
                    setattr(asset, attr, uuid.UUID(value) if attr in UUID_ATTRS else value)
                asset.updated_at = now
                audit(db, actor_id=actor, entity_type="asset", entity_id=str(asset.id),
                      action="update", changes=diff(before, snapshot(asset, list(changes))))
                if "status" in changes:
                    await record_asset_status_edit(
                        db, asset=asset, status=changes["status"], actor_person_id=actor,
                        source=SOURCE_ASSET_BULK_UPDATE)
                if "model_id" in changes:
                    model_changed.add(asset.id)
                result = "updated"
            elif action == "update":
                result = "skipped"
            else:
                result = action                 # "unchanged" or "skipped"
            counts[result] += 1
            if result != "unchanged":
                applied.append({"row": row_no, "name": r["name"], "asset_id": r["asset_id"],
                                "action": result, "diff": r["diff"]})
            if progress is not None and i % PROGRESS_EVERY == 0:
                await progress(i)

        if progress is not None:
            # one more heartbeat right before the (possibly slow) recheck and
            # commit tail, so progress_at stays fresh and the job doesn't look
            # stale to requeue_stale while it's still being worked
            await progress(len(preview["rows"]))

        summary = dict(counts)
        if model_changed:
            # only the initiatives currently doing a live move get restated —
            # a project/event holding the asset, or an archived move, is left
            # exactly as it was
            placement = {"collisions": 0, "orphans": 0, "cleared": 0}
            moves = await db.scalars(
                select(distinct(InitiativeAsset.initiative_id))
                .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
                .where(InitiativeAsset.asset_id.in_(model_changed),
                       Initiative.initiative_type == "move",
                       Initiative.archived_at.is_(None)))
            for initiative_id in list(moves):
                restated = await recheck_placement(db, initiative_id)
                placement["collisions"] += restated["collisions"]
                placement["orphans"] += restated["orphans"]
                placement["cleared"] += restated["cleared"]
            summary["placement"] = placement

        audit(db, actor_id=actor, entity_type="asset", entity_id=None,
              action="bulk_import", changes={**counts, "source": job.filename})
        finished = datetime.now(UTC)
        job.status, job.error = "completed", None
        job.processed_rows = len(preview["rows"])
        job.updated_count = counts["updated"]
        job.results = {"summary": summary, "rows": applied}
        job.progress_at = job.finished_at = finished
        await db.commit()
    except RuleExecutionError as exc:
        await db.rollback()
        # the rollback expired the job; reload it before writing the failure
        await db.refresh(job)
        job.status, job.error = "failed", "rule_failed"
        job.processed_rows = 0
        job.results = {"row": row_no, "rule_name": exc.rule_name, "message": str(exc)}
        job.finished_at = datetime.now(UTC)
    except IntegrityError:
        # a concurrent write (a duplicate RFID or serial landing on another
        # row, say) can only surface here as a raw SQL / constraint message —
        # never show that to the admin, just ask them to re-upload and see
        # the current values
        await db.rollback()
        await db.refresh(job)
        job.status, job.error = "failed", "apply_conflict"
        job.processed_rows = 0
        job.results = {"message": CONFLICT_MESSAGE}
        job.finished_at = datetime.now(UTC)


# ── templates / export ──────────────────────────────────────────────

def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], reference: list[tuple[str, list[str]]]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, reference)


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


async def _reference_lists(db: AsyncSession) -> list[tuple[str, list[str]]]:
    statuses = (await db.execute(
        select(StatusValue.key, StatusValue.label)
        .where(StatusValue.record_type == RECORD_TYPE, StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order, StatusValue.key))).all()
    models = await db.scalars(select(AssetModel).order_by(AssetModel.make, AssetModel.model))
    clients = await db.scalars(
        select(Client.name).where(Client.archived_at.is_(None)).order_by(Client.name))
    sites = await db.scalars(
        select(Site.name).where(Site.archived_at.is_(None)).order_by(Site.name))
    return [("Statuses", [f"{k} — {label}" for k, label in statuses]),
            ("Makes and models", [display_name(m) for m in models]),
            ("Clients", list(clients)), ("Sites", list(sites))]


async def build_template_xlsx(db: AsyncSession) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, await _reference_lists(db))


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live asset in template shape, by Asset ID, so an export
    re-uploads as all-unchanged. That does not always hold: an asset on an
    archived client or site, in an inactive status, or on a model whose
    "make model" another catalog row spells the same comes back needing
    attention, since the sheet round-trips names, not ids."""
    model_names = {m.id: (m.make, m.model) for m in await db.scalars(select(AssetModel))}
    client_names = {c.id: c.name for c in await db.scalars(select(Client))}
    site_names = {s.id: s.name for s in await db.scalars(select(Site))}
    cols = (Asset.legacy_id, Asset.serial_number, Asset.name, Asset.rfid_tag, Asset.model_id,
            Asset.client_id, Asset.site_id, Asset.location_detail, Asset.pod_number,
            Asset.status, Asset.has_rails)
    rows = (await db.execute(
        select(*cols).where(Asset.archived_at.is_(None)).order_by(Asset.legacy_id))).all()
    out: list[dict] = []
    for (legacy_id, serial_number, name, rfid_tag, model_id, client_id, site_id,
         location_detail, pod_number, status, has_rails) in rows:
        make, model = model_names.get(model_id, ("", "")) if model_id else ("", "")
        out.append({
            "asset_id": legacy_id, "serial_number": serial_number or "",
            "name": name or "", "new_serial_number": "", "rfid_tag": rfid_tag or "",
            "make": make, "model": model,
            "client": client_names.get(client_id, "") if client_id else "",
            "site": site_names.get(site_id, "") if site_id else "",
            "location": location_detail or "", "pod": pod_number or "",
            "status": status, "has_rails": _yes_no(has_rails) or "",
        })
    return out


async def build_export_xlsx(db: AsyncSession) -> bytes:
    return build_rows_xlsx(await export_rows(db), await _reference_lists(db))
