"""God mode — reveals the developer nav section.

This is a VISIBILITY toggle, not a permission. The server enforces the
`devtools` permission on every request regardless of god-mode state, so
guessing a word grants nothing: a non-developer who types the correct word
gets the same 404 as someone typing gibberish. That property is why this
needs no rate limiting — there is nothing behind the door to force.

The words live in SS_GOD_MODE_WORDS (server-side). A VITE_* equivalent
would be inlined into the portal bundle and readable from devtools.
"""

import secrets
import uuid
from datetime import UTC, datetime

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException
from sqlalchemy import String, cast, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql.schema import Table

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import (
    DbBackupCreateIn, DbBackupItem, GodModeIn, PendingDeleteCreateIn,
    PendingDeleteFailure, PendingDeleteOut, PendingDeleteReconcileOut,
    PendingDeleteReference,
)
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Asset, AssetModel, Base, Client, Container, DbBackup, Initiative, Partner,
    PendingDelete, Person, ProcessedScan, Site,
)
from serversherpa.security.passwords import verify_password
from serversherpa.services.audit import audit
from serversherpa.services.db_backup import (
    PgDumpFailed, PgDumpUnavailable, encrypt_openssl, run_pg_dump,
)
from serversherpa.services.storage import delete_object, presign_get, put_object

router = APIRouter(prefix="/devtools", tags=["devtools"])

# Frozen registry of every entity type god-mode is allowed to hard-delete.
# Never built from user input — a string that doesn't appear here as a key
# 422s before it can reach a query.
DELETABLE: dict[str, type] = {
    "person": Person,
    "client": Client,
    "partner": Partner,
    "site": Site,
    "asset": Asset,
    "asset_model": AssetModel,
    "container": Container,
    "initiative": Initiative,
    "processed_scan": ProcessedScan,
}


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


# One refusal for every reason — wrong word, right word from a non-developer,
# feature unconfigured. Any variance between them is the leak this avoids.
_REFUSED = HTTPException(status_code=404, detail={"code": "not_found"})


def _word_matches(candidate: str) -> bool:
    raw = get_settings().god_mode_words.get_secret_value()
    words = [w.strip() for w in raw.split(",") if w.strip()]
    # Matching is case-insensitive: these are typed by hand into the palette,
    # and case carries no defensive value here (guessing grants nothing — see
    # the module docstring).
    #
    # Compare BYTES, not str: secrets.compare_digest raises TypeError on
    # non-ASCII str, so a palette query like "café" would 500 — which both
    # errors and breaks the identical-refusal property a 500 is distinguishable
    # from a 404. Encoding sidesteps it for any input.
    probe = candidate.casefold().encode("utf-8")
    # `any()` short-circuits, but the timing tells an attacker nothing usable.
    return any(secrets.compare_digest(probe, w.casefold().encode("utf-8"))
               for w in words)


@router.post("/unlock", include_in_schema=False)
async def unlock(body: GodModeIn, user: CurrentUser, db: DbSession) -> dict:
    # Order is deliberate: Python short-circuits `or`, so a wrong word never
    # even reaches the permission check. That's safe to skip because
    # `user.access.can(...)` is a pre-resolved in-memory dict lookup, not a
    # DB call or anything else with a measurable cost — there's no timing
    # signal for an attacker to learn from which branch short-circuited.
    if not _word_matches(body.word) or not user.access.can("devtools", "view"):
        raise _REFUSED
    audit(db, actor_id=user.person.id, entity_type="auth",
          entity_id=str(user.person.id), action="godmode.enable")
    await db.commit()
    return {"nav_color": get_settings().god_mode_nav_color}


def _out(marker: PendingDelete, name: str | None) -> PendingDeleteOut:
    return PendingDeleteOut(
        id=marker.id, entity_type=marker.entity_type,
        entity_id=marker.entity_id, entity_label=marker.entity_label,
        marked_by=marker.marked_by, marked_by_name=name,
        marked_at=marker.marked_at)


@router.get("/pending-deletes", response_model=list[PendingDeleteOut])
async def list_pending_deletes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "view"),
) -> list[PendingDeleteOut]:
    rows = (await db.execute(
        select(PendingDelete, Person)
        .outerjoin(Person, Person.id == PendingDelete.marked_by)
        .order_by(PendingDelete.marked_at.desc()))).all()
    return [_out(marker, f"{p.first_name} {p.last_name}" if p else None)
            for marker, p in rows]


@router.post("/pending-deletes", response_model=PendingDeleteOut, status_code=201)
async def mark_pending_delete(
    body: PendingDeleteCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteOut:
    model = DELETABLE.get(body.entity_type)
    if model is None:
        raise _err(422, "unknown_entity_type")
    if await db.get(model, body.entity_id) is None:
        raise _err(422, "entity_not_found")
    existing = await db.scalar(select(PendingDelete).where(
        PendingDelete.entity_type == body.entity_type,
        PendingDelete.entity_id == body.entity_id))
    if existing is not None:
        raise _err(409, "already_pending")
    marker = PendingDelete(
        entity_type=body.entity_type, entity_id=body.entity_id,
        entity_label=body.entity_label, marked_by=actor.person.id)
    db.add(marker)
    await db.commit()
    return _out(marker, f"{actor.person.first_name} {actor.person.last_name}")


@router.delete("/pending-deletes/{marker_id}", status_code=204)
async def unmark_pending_delete(
    marker_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> None:
    marker = await db.get(PendingDelete, marker_id)
    if marker is None:
        raise _err(404, "marker_not_found")
    await db.delete(marker)
    await db.commit()


# Frozen label-column map for reference discovery: how to render a human
# label for a row in a referencing table. Unmapped tables fall back to the
# row's own primary key, stringified — never blank.
_NAME_LABELED = {"initiatives", "sites", "containers", "clients", "partners"}

# Pure association tables: rows here carry no data of their own beyond the
# link, so force mode may DELETE them outright (a non-nullable FK on a join
# row can never be nulled). Frozen — never derived from the schema, because
# "looks like a join table" is not a safe heuristic for rows that might
# carry real data (e.g. user_accounts also references people).
PURGE_ROW_TABLES = frozenset({
    "site_clients", "initiative_people", "initiative_links",
    "container_assets",
})

# Actor/audit-ish columns that make poor label joins on association rows.
_ACTOR_COLUMNS = frozenset({"created_by", "marked_by", "added_by", "granted_by",
                            "audit_by", "revoked_by", "linked_by"})


def _label_expr(table: Table):
    if table.name in _NAME_LABELED:
        return table.c.name
    if table.name == "assets":
        return func.coalesce(table.c.serial_number, table.c.name)
    if table.name == "people":
        return table.c.first_name + " " + table.c.last_name
    if table.name == "asset_models":
        return table.c.make + " " + table.c.model
    pk = next(iter(table.primary_key.columns))
    return cast(pk, String)


def _references_to(model: type):
    """Yields (table, column) for every column anywhere in the schema whose
    foreign key targets `model`'s primary key — the mechanism behind both
    reference discovery and force-null."""
    target_pk = next(iter(model.__table__.primary_key.columns))
    for table in Base.metadata.tables.values():
        for fk in table.foreign_keys:
            if fk.column is target_pk:
                yield table, fk.parent


def _other_fk(table: Table, matching_col):
    """On an association row, the FK that ISN'T the one pointing at the
    delete target — the side whose label a human actually recognises
    (site_clients row blocking a client delete → the site's name)."""
    for fk in table.foreign_keys:
        if fk.parent is not matching_col and fk.parent.name not in _ACTOR_COLUMNS:
            return fk
    return None


async def _find_references(
    db: DbSession, model: type, entity_id: uuid.UUID,
) -> list[PendingDeleteReference]:
    """Walks the schema for every column that FKs to `model`'s primary key
    and reports which ones currently have rows pointing at `entity_id` —
    the "what's still using this" detail behind an fk_violation failure."""
    refs: list[PendingDeleteReference] = []
    for table, col in _references_to(model):
        count = await db.scalar(
            select(func.count()).select_from(table).where(col == entity_id))
        if not count:
            continue
        label_query = (select(_label_expr(table)).select_from(table)
                       .where(col == entity_id).limit(3))
        if table.name in PURGE_ROW_TABLES:
            # a join row's own PK means nothing to a human — label it by
            # the other side of the association instead
            other = _other_fk(table, col)
            if other is not None:
                label_query = (
                    select(_label_expr(other.column.table))
                    .select_from(table.join(
                        other.column.table, other.parent == other.column))
                    .where(col == entity_id).limit(3))
        labels = list(await db.scalars(label_query))
        refs.append(PendingDeleteReference(
            table=table.name, column=col.name, nullable=col.nullable,
            purgeable=table.name in PURGE_ROW_TABLES,
            count=count, labels=[str(v) for v in labels]))
    return refs


async def _detach_references(
    db: DbSession, model: type, entity_id: uuid.UUID,
) -> tuple[dict[str, int], dict[str, int]]:
    """Force-mode mechanics, ahead of the delete: association rows in
    PURGE_ROW_TABLES are deleted outright (their FK is non-nullable by
    design — a link with a nulled end is meaningless), and every other
    NULLABLE referencing column is nulled. Anything else is left
    untouched — if it still blocks the delete, the IntegrityError path
    below reports it as a reference like any other failure."""
    nulled: dict[str, int] = {}
    removed: dict[str, int] = {}
    for table, col in _references_to(model):
        if table.name in PURGE_ROW_TABLES:
            result = await db.execute(delete(table).where(col == entity_id))
            if result.rowcount:
                removed[table.name] = removed.get(table.name, 0) + result.rowcount
        elif col.nullable:
            result = await db.execute(
                update(table).where(col == entity_id).values({col.name: None}))
            if result.rowcount:
                nulled[f"{table.name}.{col.name}"] = result.rowcount
    return nulled, removed


async def _reconcile_markers(
    db: DbSession, actor: AuthContext, markers: list[PendingDelete],
    force: bool = False,
) -> PendingDeleteReconcileOut:
    """Hard-delete the given marked targets. Each target runs inside its own
    savepoint so one FK violation rolls back only that row, not the batch:
    a poisoned marker further down the list still gets its chance.

    `force` (single-marker reconcile only — bulk reconcile never sets it)
    nulls every NULLABLE reference to the target before deleting it;
    non-nullable references are left alone, so if one still blocks the
    delete the IntegrityError path reports it exactly like any other
    fk_violation failure."""
    deleted = 0
    failed: list[PendingDeleteFailure] = []
    for marker in markers:
        model = DELETABLE[marker.entity_type]
        target_table = model.__table__
        target_pk = next(iter(target_table.primary_key.columns))
        try:
            async with db.begin_nested():
                exists = await db.scalar(
                    select(target_pk).where(target_pk == marker.entity_id))
                if exists is not None:
                    nulled, removed = (
                        await _detach_references(db, model, marker.entity_id)
                        if force else ({}, {}))
                    # Core DELETE, deliberately not db.delete(orm_obj): the ORM
                    # path runs relationship dependency rules that can raise a
                    # plain AssertionError (e.g. person ↔ user_account) instead
                    # of letting Postgres report the FK violation we catch below.
                    await db.execute(
                        delete(target_table).where(target_pk == marker.entity_id))
                    await db.flush()
                    changes = {}
                    if nulled:
                        changes["nulled_references"] = nulled
                    if removed:
                        changes["removed_association_rows"] = removed
                    audit(db, actor_id=actor.person.id,
                          entity_type=marker.entity_type,
                          entity_id=str(marker.entity_id), action="hard_delete",
                          changes=changes or None)
                # a target already gone is a success too — clear the marker
                await db.delete(marker)
                await db.flush()
        except IntegrityError:
            # savepoint rolled back automatically: the target, the marker,
            # any nulled references, and any audit row attempted inside this
            # block are all as if nothing happened — the marker is retained
            # for a later retry. The session is still usable post-rollback,
            # so we can look up what's still blocking right here.
            failed.append(PendingDeleteFailure(
                entity_type=marker.entity_type, entity_id=marker.entity_id,
                label=marker.entity_label, reason="fk_violation",
                references=await _find_references(db, model, marker.entity_id)))
            continue
        deleted += 1
    await db.commit()
    return PendingDeleteReconcileOut(deleted=deleted, failed=failed)


@router.post("/pending-deletes/reconcile", response_model=PendingDeleteReconcileOut)
async def reconcile_pending_deletes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteReconcileOut:
    markers = list(await db.scalars(
        select(PendingDelete).order_by(PendingDelete.marked_at)))
    return await _reconcile_markers(db, actor, markers)


@router.post("/pending-deletes/{marker_id}/reconcile",
             response_model=PendingDeleteReconcileOut)
async def reconcile_pending_delete(
    marker_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
    force: bool = False,
) -> PendingDeleteReconcileOut:
    """Hard-delete a single marked target — same semantics and summary
    shape as the bulk reconcile, scoped to one marker. `force=true` nulls
    every nullable reference to the target before deleting it; bulk
    reconcile has no such switch."""
    marker = await db.get(PendingDelete, marker_id)
    if marker is None:
        raise _err(404, "marker_not_found")
    return await _reconcile_markers(db, actor, [marker], force=force)


# ── db backups ───────────────────────────────────────────────────────


def _backup_out(backup: DbBackup, name: str | None,
                download_url: str | None = None) -> DbBackupItem:
    return DbBackupItem(
        id=backup.id, filename=backup.filename, size_bytes=backup.size_bytes,
        encrypted=backup.encrypted,
        created_at=backup.created_at, created_by=backup.created_by,
        created_by_name=name, download_url=download_url)


@router.get("/backups", response_model=list[DbBackupItem])
async def list_db_backups(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "view"),
) -> list[DbBackupItem]:
    rows = (await db.execute(
        select(DbBackup, Person)
        .outerjoin(Person, Person.id == DbBackup.created_by)
        .order_by(DbBackup.created_at.desc()))).all()
    return [_backup_out(backup, f"{p.first_name} {p.last_name}" if p else None)
            for backup, p in rows]


@router.post("/backups", response_model=DbBackupItem)
async def create_db_backup(
    body: DbBackupCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> DbBackupItem:
    settings = get_settings()
    if body.encrypt:
        # The dump is encrypted with the CALLER's own account password, so
        # we must be certain it's really theirs before we ever touch
        # pg_dump — nothing downstream of this check may see or store
        # body.password.
        if not body.password:
            raise _err(422, "password_required")
        if not verify_password(actor.account.password_hash, body.password,
                               pepper=settings.password_pepper.get_secret_value()):
            raise _err(403, "invalid_password")

    try:
        dump = await run_pg_dump(settings.database_url.get_secret_value())
    except PgDumpUnavailable:
        raise _err(500, "pg_dump_unavailable") from None
    except PgDumpFailed:
        raise _err(500, "pg_dump_failed") from None

    if body.encrypt:
        blob = encrypt_openssl(dump, body.password or "")
        suffix, content_type = ".sql.enc", "application/octet-stream"
    else:
        blob = dump
        suffix, content_type = ".sql", "application/sql"
    now = datetime.now(UTC)
    filename = f"serversherpa_backup_{now.strftime('%Y%m%d_%H%M%S')}{suffix}"
    key = f"backups/{uuid.uuid4()}{suffix}"
    await put_object(key, blob, content_type)

    backup = DbBackup(filename=filename, storage_key=key,
                      size_bytes=len(blob), encrypted=body.encrypt,
                      created_by=actor.person.id)
    db.add(backup)
    await db.flush()

    # changes carries only filename + size + mode — never the password,
    # and never anything that could reconstruct it
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id=str(backup.id), action="backup.create",
          changes={"filename": filename, "size_bytes": len(blob),
                   "encrypted": body.encrypt})
    await db.commit()

    return _backup_out(
        backup, f"{actor.person.first_name} {actor.person.last_name}",
        download_url=presign_get(key, download_filename=filename))


@router.get("/backups/{backup_id}/download")
async def download_db_backup(
    backup_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "view"),
) -> dict:
    backup = await db.get(DbBackup, backup_id)
    if backup is None:
        raise _err(404, "not_found")
    return {"url": presign_get(backup.storage_key,
                               download_filename=backup.filename)}


@router.delete("/backups/{backup_id}", status_code=204)
async def delete_db_backup(
    backup_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> None:
    backup = await db.get(DbBackup, backup_id)
    if backup is None:
        raise _err(404, "not_found")
    try:
        await delete_object(backup.storage_key)
    except ClientError as exc:
        # the row is the source of truth here — an object already gone
        # (or never written) is not a failure worth reporting
        if exc.response.get("Error", {}).get("Code") not in ("NoSuchKey", "404"):
            raise
    await db.delete(backup)
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id=str(backup_id), action="backup.delete",
          changes={"filename": backup.filename, "size_bytes": backup.size_bytes})
    await db.commit()
