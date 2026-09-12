"""process_run(db, run, *, sessionmaker) — drives one claimed run through
every requested label type and every asset on the initiative's roster.

Port of V2's `process_label_generation_job` (portal_routes.py), with the
deliberate differences the design spec calls out: a missing template
fails only that label type (V2 failed the whole job); unknown tokens are
counted in `error_summary` instead of silently blanking (see
labels/generate/engine.py); labels land in `generated_labels` instead of
JSON on the roster row.

Session discipline: everything the loop needs from `run` (initiative_id,
label_types, regenerate_existing) is read ONCE into plain locals up
front, and `run`'s ORM attributes are only ever written right before a
commit (the batch boundary, or the terminal write). The one per-asset
statement that can fail at the DB level — `_upsert_label` — runs inside
its own SAVEPOINT (`db.begin_nested()`): on failure only that statement
is rolled back (to the savepoint, not the whole transaction), so the
rest of the batch's already-executed upserts survive to the next
commit. An earlier version instead called `Session.rollback()` on the
whole session and reloaded the long-lived objects it expired — that
rolled back every OTHER upsert already queued in the same batch too
while `generated` kept counting them, so the run reported labels that
were never written. See test_runner_db_failure_on_one_asset_does_not_
lose_other_writes_in_batch for the regression proof."""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import literal_column, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, GeneratedLabel, Initiative, InitiativeAsset,
    LabelGenerationRun, LabelPlaceholder, LabelTemplate, LabelVocab, Site,
)
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.generate.select import select_template
from serversherpa.labels.generate.values import AssetRow, Sites, placeholder_values
from serversherpa.notifications.inbox import notify

logger = logging.getLogger("serversherpa.labels.generate.runner")

BATCH_SIZE = 200
ERROR_DETAILS_MAX = 50
ERROR_MESSAGE_MAX = 500
ERROR_MAX = 2000
NIL_UUID = uuid.UUID("00000000-0000-0000-0000-000000000000")
# The same sentinel rendered verbatim into SQL (see _upsert_label).
NIL_UUID_SQL = literal_column(f"'{NIL_UUID}'::uuid")


def _record_error(details: list[dict], *, item: str, label_type: str, kind: str,
                  message: str) -> None:
    if len(details) < ERROR_DETAILS_MAX:
        details.append({"item": item, "label_type": label_type, "type": kind,
                        "message": message[:ERROR_MESSAGE_MAX]})


def _tag_error(error_summary: dict[str, int], error_details: list[dict], *,
               item: str, label_type: str, exc: Exception) -> None:
    cls = type(exc).__name__
    error_summary[cls] = error_summary.get(cls, 0) + 1
    _record_error(error_details, item=item, label_type=label_type, kind=cls, message=str(exc))


async def _load_roster(db: AsyncSession, initiative_id: uuid.UUID) -> list[AssetRow]:
    rows = (await db.execute(
        select(Asset, InitiativeAsset, AssetModel)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id)
        .order_by(Asset.legacy_id))).all()
    return [
        AssetRow(asset_id=asset.id, legacy_id=asset.legacy_id, name=asset.name,
                serial_number=asset.serial_number, make=model.make if model else None,
                model=model.model if model else None, source_rack=ia.source_rack,
                source_ru=ia.source_ru, source_position=ia.source_position,
                destination_rack=ia.destination_rack, destination_ru=ia.destination_ru,
                destination_position=ia.destination_position)
        for asset, ia, model in rows
    ]


def _item_label(row: AssetRow) -> str:
    if row.serial_number:
        return row.serial_number
    return str(row.legacy_id) if row.legacy_id is not None else "unknown"


async def _load_existing_for_type(
    db: AsyncSession, initiative_id: uuid.UUID, label_type: str,
) -> dict[uuid.UUID, tuple[uuid.UUID, int, bool]]:
    """One query per label type instead of one SELECT per asset: every
    current `generated_labels` row for this (initiative, type), keyed by
    entity_id -> (template_id, template_version, stale) — everything
    `_generate_one` needs to decide skip vs regenerate."""
    rows = (await db.execute(select(
        GeneratedLabel.entity_id, GeneratedLabel.template_id,
        GeneratedLabel.template_version, GeneratedLabel.stale,
    ).where(GeneratedLabel.entity_type == "asset",
           GeneratedLabel.initiative_id == initiative_id,
           GeneratedLabel.label_type == label_type))).all()
    return {entity_id: (template_id, version, stale)
           for entity_id, template_id, version, stale in rows}


async def _upsert_label(db: AsyncSession, *, initiative_id: uuid.UUID, run_id: uuid.UUID,
                        row: AssetRow, label_type: str, template: LabelTemplate, code: str,
                        values: dict) -> None:
    fields = dict(
        entity_type="asset", entity_id=row.asset_id, initiative_id=initiative_id,
        label_type=label_type, template_id=template.id, template_version=template.version,
        language_key=template.language_key, dpi_key=template.dpi_key,
        size_key=template.size_key, code=code, values=values, run_id=run_id,
        generated_at=datetime.now(UTC), stale=False)
    stmt = pg_insert(GeneratedLabel).values(**fields)
    settable = {k: v for k, v in fields.items()
               if k not in ("entity_type", "entity_id", "initiative_id", "label_type")}
    stmt = stmt.on_conflict_do_update(
        index_elements=[GeneratedLabel.entity_type, GeneratedLabel.entity_id,
                        # Inline literal, NOT a bind parameter: Postgres infers the
                        # ON CONFLICT target at plan time, and once asyncpg's prepared
                        # statement flips to a generic plan (after 5 executions) a
                        # parameter no longer folds to the index's constant — the
                        # 6th label of every run then failed with "no unique or
                        # exclusion constraint matching the ON CONFLICT specification".
                        func.coalesce(GeneratedLabel.initiative_id, NIL_UUID_SQL),
                        GeneratedLabel.label_type],
        set_=settable)
    async with db.begin_nested():        # SAVEPOINT: a failure here rolls back
        await db.execute(stmt)            # only this statement, not the batch


async def _generate_one(
    db: AsyncSession, *, initiative_id: uuid.UUID, run_id: uuid.UUID,
    regenerate_existing: bool, row: AssetRow, item: str, label_type: str,
    template: LabelTemplate, size_meta: dict, dpi_meta: dict, catalog_keys: list[str],
    initiative: Initiative, sites: Sites, seen_unknown: set[str],
    error_summary: dict[str, int], error_details: list[dict],
    existing_by_asset: dict[uuid.UUID, tuple[uuid.UUID, int, bool]],
) -> str:
    """Generate (or skip) one asset's label for one type. Returns
    'generated', 'skipped', or 'error' — errors are recorded onto
    error_summary/error_details here so the caller stays a flat counter
    bump. Only `_upsert_label`'s statement can fail at the DB level (the
    skip check is now a plain dict lookup, not a query); it runs in its
    own SAVEPOINT so a failure there can't cost the batch's other
    already-written rows."""
    existing = existing_by_asset.get(row.asset_id)
    if (existing is not None and not regenerate_existing
            and existing[0] == template.id and existing[1] == template.version
            and not existing[2]):
        return "skipped"

    try:
        values = placeholder_values(row, initiative, sites, catalog_keys,
                                    generation_rules=template.generation_rules)
        code, unknown = render_label(template, values, size_meta=size_meta, dpi_meta=dpi_meta,
                                     language_key=template.language_key)
    except Exception as exc:
        _tag_error(error_summary, error_details, item=item, label_type=label_type, exc=exc)
        return "error"

    for tok in unknown:
        uk = f"unknown_token:{tok}"
        if uk not in seen_unknown:
            seen_unknown.add(uk)
            error_summary[uk] = 1

    try:
        await _upsert_label(db, initiative_id=initiative_id, run_id=run_id, row=row,
                            label_type=label_type, template=template, code=code, values=values)
    except Exception as exc:
        _tag_error(error_summary, error_details, item=item, label_type=label_type, exc=exc)
        return "error"
    return "generated"


async def _cancel_requested(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """A fresh column-select — never satisfied from the identity map — so
    a second session's `cancel_requested` write (committed between our
    batches) is actually seen."""
    return bool(await db.scalar(
        select(LabelGenerationRun.cancel_requested).where(LabelGenerationRun.id == run_id)))


async def _notify(sessionmaker, run_id: uuid.UUID) -> None:
    try:
        async with sessionmaker() as nb:
            run = await nb.get(LabelGenerationRun, run_id)
            if run is None or not run.notify:
                return
            if run.status == "canceled":
                # a user-requested cancel is not a failure — sending
                # `labels_failed` ("Label generation failed" / body
                # "Canceled") would read as an error report for something
                # the user themselves stopped. Send nothing, same as V2
                # gave no completion alert for a cancel.
                return
            initiative = await nb.get(Initiative, run.initiative_id)
            initiative_name = initiative.name if initiative else "?"
            link = f"/labels/generate?run={run_id}"
            payload = {"run_id": str(run_id)}
            if run.status == "completed":
                await notify(nb, run.requested_by, "labels_ready", "Labels are ready",
                             body=initiative_name, link=link, payload=payload)
            else:
                await notify(nb, run.requested_by, "labels_failed", "Label generation failed",
                             body=run.error or "unknown error", link=link, payload=payload)
            await nb.commit()
    except Exception:
        logger.warning("could not write the inbox row for run %s", run_id, exc_info=True)


async def process_run(db: AsyncSession, run: LabelGenerationRun, *, sessionmaker) -> str:
    run_id = run.id
    initiative_id = run.initiative_id
    label_types = list(run.label_types)
    regenerate_existing = run.regenerate_existing

    try:
        initiative = await db.get(Initiative, initiative_id)
        if initiative is None:
            raise RuntimeError(f"initiative {initiative_id} not found")

        origin = (await db.get(Site, initiative.origin_site_id)
                  if initiative.origin_site_id else None)
        destination = (await db.get(Site, initiative.destination_site_id)
                       if initiative.destination_site_id else None)
        sites = Sites(origin=origin, destination=destination)
        template_site_id = initiative.destination_site_id or initiative.origin_site_id

        roster = await _load_roster(db, initiative_id)
        catalog_keys = list((await db.execute(
            select(LabelPlaceholder.key).where(LabelPlaceholder.is_active == True)  # noqa: E712
        )).scalars())

        total = len(roster) * len(label_types)
        processed = generated = skipped = errors = 0
        error_summary: dict[str, int] = {}
        error_details: list[dict] = []
        seen_unknown: set[str] = set()

        run.total = total
        run.processed = 0
        run.heartbeat_at = datetime.now(UTC)
        await db.commit()

        canceled = False
        batch_count = 0

        for label_type in label_types:
            if canceled:
                break
            template = await select_template(db, label_type, template_site_id)
            size_meta = dpi_meta = None
            existing_by_asset: dict[uuid.UUID, tuple[uuid.UUID, int, bool]] = {}
            if template is not None:
                size_row = await db.get(LabelVocab, ("size", template.size_key))
                dpi_row = await db.get(LabelVocab, ("dpi", template.dpi_key))
                size_meta = size_row.meta if size_row else {}
                dpi_meta = dpi_row.meta if dpi_row else {}
                existing_by_asset = await _load_existing_for_type(db, initiative_id, label_type)

            for row in roster:
                item = _item_label(row)

                if template is None:
                    key = f"no_template:{label_type}"
                    error_summary[key] = error_summary.get(key, 0) + 1
                    errors += 1
                    _record_error(error_details, item=item, label_type=label_type,
                                 kind="no_template", message=f"No active template for {label_type}")
                else:
                    outcome = await _generate_one(
                        db, initiative_id=initiative_id, run_id=run_id,
                        regenerate_existing=regenerate_existing, row=row, item=item,
                        label_type=label_type, template=template, size_meta=size_meta,
                        dpi_meta=dpi_meta, catalog_keys=catalog_keys, initiative=initiative,
                        sites=sites, seen_unknown=seen_unknown, error_summary=error_summary,
                        error_details=error_details, existing_by_asset=existing_by_asset)
                    if outcome == "generated":
                        generated += 1
                    elif outcome == "skipped":
                        skipped += 1
                    else:
                        errors += 1

                processed += 1
                batch_count += 1
                if batch_count >= BATCH_SIZE:
                    run.current_label_type = label_type
                    run.current_item = item
                    run.processed, run.generated = processed, generated
                    run.skipped, run.errors = skipped, errors
                    run.error_summary = dict(error_summary)
                    run.error_details = list(error_details)
                    run.heartbeat_at = datetime.now(UTC)
                    await db.commit()
                    batch_count = 0
                    if await _cancel_requested(db, run_id):
                        canceled = True
                        break
            if canceled:
                break

        status = "canceled" if canceled else "completed"
        run.status = status
        run.total, run.processed = total, processed
        run.generated, run.skipped, run.errors = generated, skipped, errors
        run.error_summary = dict(error_summary)
        run.error_details = list(error_details)
        run.current_label_type = None
        run.current_item = None
        run.finished_at = datetime.now(UTC)
        run.heartbeat_at = datetime.now(UTC)
        await db.commit()
    except Exception as exc:
        logger.exception("run %s failed: %s", run_id, exc)
        try:
            await db.rollback()
        except Exception:
            logger.warning("could not roll back the build session for run %s",
                           run_id, exc_info=True)
        async with sessionmaker() as fin:
            fresh = await fin.get(LabelGenerationRun, run_id)
            if fresh is not None:
                fresh.status = "failed"
                fresh.error = f"{type(exc).__name__}: {exc}"[:ERROR_MAX]
                fresh.finished_at = datetime.now(UTC)
                await fin.commit()
        await _notify(sessionmaker, run_id)
        return "failed"

    await _notify(sessionmaker, run_id)
    return status
