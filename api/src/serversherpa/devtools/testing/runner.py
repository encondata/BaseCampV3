"""DB testing session processing: snapshot (spin up) and revert (tear
down). Mirrors the shape of reports/worker.py's process_run — claim,
process to a terminal status, survive failures — but a testing session is
its own animal (two very different jobs depending on status) rather than
a registry of pluggable build() modules, so both live here as one
function keyed on `session.status`.

Session discipline for the revert path in particular: dropping and
recreating the `public` schema invalidates every other row this same
transaction might have touched (including the session's own row and its
snapshot's db_backups row — the restore rolls the whole schema back to
before either existed), so revert runs its own raw connection lifecycle
for the destructive steps and re-inserts what it needs afterward from
values held in memory, rather than trying to keep reusing `db`."""

import logging
import uuid
from datetime import UTC, datetime

import asyncpg
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.engine import dispose_engine
from serversherpa.db.models import DbBackup, DbTestingSession, SystemConfig
from serversherpa.services.audit import audit
from serversherpa.services.db_backup import (
    PgDumpFailed, PgDumpUnavailable, PsqlFailed, PsqlUnavailable,
    run_pg_dump, run_psql_restore,
)
from serversherpa.services.storage import get_object, put_object
from serversherpa.system.config_store import read_section

logger = logging.getLogger("serversherpa.devtools.testing.runner")

ERROR_MAX = 2000
BANNER_TEMPLATE = (
    "Database testing mode is ON since {started_at} — changes will be "
    "reverted when testing ends")


def _banner_message(started_at: datetime) -> str:
    stamp = started_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return BANNER_TEMPLATE.format(started_at=stamp)


async def _row_counts(db: AsyncSession) -> dict[str, int]:
    """`SELECT count(*)` per public table — dev-scale, per the design doc;
    not `pg_class.reltuples`, which is only an estimate."""
    rows = await db.execute(
        text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
             "ORDER BY tablename"))
    counts: dict[str, int] = {}
    for (name,) in rows:
        counts[name] = await db.scalar(text(f'SELECT count(*) FROM "{name}"'))
    return counts


async def _write_admin_config(db: AsyncSession, patch: dict) -> dict:
    """Merge `patch` into the `admin` system_config section and return the
    section's content BEFORE the patch — the caller's own "previous"
    value to restore later."""
    stored = await read_section(db, "admin")
    data = {**stored, **patch}
    row = await db.get(SystemConfig, "admin")
    if row is None:
        row = SystemConfig(section="admin")
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    return stored


async def _fail(db: AsyncSession, session: DbTestingSession, error: str) -> None:
    session.status = "failed"
    session.error = error[:ERROR_MAX]
    audit(db, actor_id=session.started_by, entity_type="system",
          entity_id=str(session.id), action="db_testing.failed",
          changes={"error": session.error})
    await db.commit()


async def _run_snapshot(db: AsyncSession, session: DbTestingSession) -> None:
    settings = get_settings()
    try:
        dump = await run_pg_dump(settings.database_url.get_secret_value())
    except (PgDumpUnavailable, PgDumpFailed) as exc:
        await _fail(db, session, f"{type(exc).__name__}: {exc}")
        return

    now = datetime.now(UTC)
    filename = f"testing_snapshot_{now.strftime('%Y%m%d_%H%M%S')}.sql"
    key = f"backups/testing/{uuid.uuid4()}.sql"
    # Plain SQL, never encrypted — this is an internal safety net, not a
    # downloadable artifact meant to leave the host.
    await put_object(key, dump, "application/sql")

    backup = DbBackup(filename=filename, storage_key=key, size_bytes=len(dump),
                      encrypted=False, purpose="testing_snapshot",
                      created_by=session.started_by)
    db.add(backup)
    await db.flush()

    row_counts = await _row_counts(db)
    previous_banner = await _write_admin_config(db, {
        "banner_enabled": True,
        "banner_message": _banner_message(session.started_at),
    })

    session.snapshot_backup_id = backup.id
    session.row_counts = row_counts
    session.previous_banner = previous_banner
    session.status = "active"
    audit(db, actor_id=session.started_by, entity_type="system",
          entity_id=str(session.id), action="db_testing.snapshotted",
          changes={"snapshot_backup_id": str(backup.id),
                   "tables": len(row_counts)})
    await db.commit()


async def _terminate_backends_and_reset_schema(database_url: str) -> None:
    """Kill every other backend on this database, then drop and recreate
    the `public` schema — over its own raw asyncpg connection, never the
    ORM engine's pool: a pooled asyncpg connection caches prepared
    statements keyed to type/table OIDs that go stale the instant the
    schema they pointed at is gone, so nothing already checked out of that
    pool may be reused past this point. Disposing the ORM engine here
    (rather than as a separate step) keeps that guarantee attached to the
    one call that actually invalidates every pooled connection — and
    keeps tests that stub out the schema reset from also touching the
    engine the rest of the suite depends on."""
    url = make_url(database_url.replace("+asyncpg", ""))
    conn = await asyncpg.connect(
        user=url.username, password=url.password, host=url.host,
        port=url.port, database=url.database)
    try:
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid()")
        await conn.execute("DROP SCHEMA public CASCADE")
        await conn.execute("CREATE SCHEMA public")
    finally:
        await conn.close()
    await dispose_engine()


async def _run_revert(db: AsyncSession, session: DbTestingSession, *,
                      sessionmaker) -> None:
    settings = get_settings()
    database_url = settings.database_url.get_secret_value()

    backup = await db.get(DbBackup, session.snapshot_backup_id)
    if backup is None:
        await _fail(db, session, "snapshot_backup_missing")
        return
    try:
        dump = await get_object(backup.storage_key)
    except Exception as exc:                                    # noqa: BLE001
        await _fail(db, session, f"snapshot_unreadable: {exc}")
        return

    # In-memory copies of everything the restore is about to wipe out —
    # the schema drop takes the session row, the backup row, and whatever
    # the admin config table looked like with it.
    session_id = session.id
    started_by = session.started_by
    started_at = session.started_at
    snapshot_backup_id = session.snapshot_backup_id
    previous_banner = session.previous_banner
    error: str | None = None

    async with sessionmaker() as guard:
        await _write_admin_config(guard, {"read_only": True, "pause_workers": True})
        await guard.commit()

    try:
        await _terminate_backends_and_reset_schema(database_url)
        await run_psql_restore(database_url, dump)
    except (PsqlUnavailable, PsqlFailed) as exc:
        error = f"{type(exc).__name__}: {exc}"
    except Exception as exc:                                    # noqa: BLE001
        logger.exception("db-testing revert failed for session %s", session_id)
        error = f"{type(exc).__name__}: {exc}"

    async with sessionmaker() as fin:
        if error is not None:
            # A half-restored database must not be written to — read-only
            # (set above) stays ON, and the failure is reported through a
            # freshly-inserted row since the restore may have wiped the
            # original one.
            existing = await fin.get(DbTestingSession, session_id)
            if existing is None:
                fin.add(DbTestingSession(
                    id=session_id, status="failed", error=error[:ERROR_MAX],
                    row_counts={}, audit_watermark=started_at,
                    started_by=started_by, started_at=started_at,
                    snapshot_backup_id=snapshot_backup_id))
            else:
                existing.status = "failed"
                existing.error = error[:ERROR_MAX]
            audit(fin, actor_id=started_by, entity_type="system",
                  entity_id=str(session_id), action="db_testing.failed",
                  changes={"error": error[:ERROR_MAX]})
            await fin.commit()
            return

        # Re-insert what the restore wiped: the snapshot's own db_backups
        # row, and the session as ended/reverted.
        restored_backup = await fin.get(DbBackup, snapshot_backup_id)
        if restored_backup is None:
            fin.add(DbBackup(
                id=snapshot_backup_id, filename=backup.filename,
                storage_key=backup.storage_key, size_bytes=backup.size_bytes,
                encrypted=backup.encrypted, purpose="testing_snapshot",
                created_by=started_by))

        restored_session = await fin.get(DbTestingSession, session_id)
        ended_at = datetime.now(UTC)
        if restored_session is None:
            fin.add(DbTestingSession(
                id=session_id, status="ended", ended_with="reverted",
                ended_at=ended_at, row_counts={}, audit_watermark=started_at,
                started_by=started_by, started_at=started_at,
                snapshot_backup_id=snapshot_backup_id))
        else:
            restored_session.status = "ended"
            restored_session.ended_with = "reverted"
            restored_session.ended_at = ended_at

        await _write_admin_config(fin, previous_banner or {"read_only": False})
        audit(fin, actor_id=started_by, entity_type="system",
              entity_id=str(session_id), action="db_testing.reverted",
              changes={})
        await fin.commit()


async def process_session(db: AsyncSession, session: DbTestingSession, *,
                          sessionmaker) -> str:
    """Process one claimed session to a terminal (for this phase) status.
    Returns the status the session ended this call in."""
    if session.status == "snapshotting":
        await _run_snapshot(db, session)
    elif session.status == "reverting":
        await _run_revert(db, session, sessionmaker=sessionmaker)
    else:                                                       # pragma: no cover
        raise ValueError(f"nothing to process for status {session.status!r}")
    async with sessionmaker() as fresh:
        refreshed = await fresh.get(DbTestingSession, session.id)
        return refreshed.status if refreshed is not None else session.status
