"""DB testing session processing: snapshot (spin up) and revert (tear
down). Claim/heartbeat mechanics follow labels/generate/jobs.py (a row
that needs work, staleness judged on heartbeat_at, no queued<->running
transition to fall back on); process to a terminal status, survive
failures — but a testing session is its own animal (two very different
jobs depending on status) rather than a registry of pluggable build()
modules, so both live here as one function keyed on `session.status`.

Session discipline for the revert path: the schema drop/recreate now
travels INSIDE the psql restore's own `--single-transaction`, so a failed
restore rolls the drop back too and the pre-attempt database (including
this session's own row, still `reverting`) survives untouched — see
`_terminate_other_backends_and_dispose` and `_run_revert` below. Only a
*successful* restore rewinds the database to before the dump: the
session's own row IS in that dump (the API inserts it, and the worker
claims it — both committed — before `run_pg_dump` ever runs), so it comes
back as `snapshotting` rather than vanishing; the snapshot's own
`db_backups` row and the admin-config banner both post-date the dump (the
worker writes them only after `run_pg_dump` returns), so those two
——and only those two — must be rebuilt from values held in memory."""

import logging
import uuid
from datetime import UTC, datetime

import asyncpg
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.engine import dispose_engine, get_sessionmaker
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

# Fed to psql ahead of the dump, inside the SAME `--single-transaction` —
# see `_run_revert`. Postgres DDL is transactional, so if the restore
# fails partway through, this drop rolls back with it instead of leaving
# `public` empty. `CREATE EXTENSION` recreates the one extension the
# CASCADE drop takes down with the schema (citext, used by `people.email`)
# — `IF NOT EXISTS` makes it a no-op if the dump itself already carries it.
_SCHEMA_RESET_SQL = (
    b"DROP SCHEMA public CASCADE;\n"
    b"CREATE SCHEMA public;\n"
    b"CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;\n"
)


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


async def _terminate_other_backends_and_dispose(database_url: str) -> None:
    """Kill every other backend on this database — over its own raw
    asyncpg connection, never the ORM engine's pool — then dispose that
    pool. The schema drop/recreate itself does NOT happen here: it travels
    inside the psql restore's own transaction (see `_run_revert`) so a
    failed restore rolls the drop back too, instead of leaving `public`
    permanently empty if this function ran the DDL in autocommit ahead of
    a restore that then failed.

    Disposing the engine here means nothing checked out of the ORM pool
    before the terminate is ever reused once its physical connection is
    gone (asyncpg caches prepared-statement OIDs that go stale the moment
    the schema they pointed at changes underneath a still-open
    connection) — and it keeps that guarantee attached to the one call
    that actually invalidates every pooled connection, so a test that
    stubs this whole function out never touches the engine the rest of
    the suite depends on."""
    url = make_url(database_url.replace("+asyncpg", ""))
    conn = await asyncpg.connect(
        user=url.username, password=url.password, host=url.host,
        port=url.port, database=url.database)
    try:
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid()")
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

    # In-memory copies of the two things a SUCCESSFUL restore wipes out —
    # the snapshot's own db_backups row and the admin-config banner, both
    # written after run_pg_dump ran (see the module docstring). The
    # session's own row needs no memorized copy: it predates the dump and
    # comes back on its own, just in its pre-snapshot 'snapshotting' shape.
    session_id = session.id
    started_by = session.started_by
    started_at = session.started_at
    snapshot_backup_id = session.snapshot_backup_id
    previous_banner = session.previous_banner
    row_counts = session.row_counts
    error: str | None = None

    # Release this session's own pooled connection before anything
    # destructive: pg_terminate_backend is about to kill every other
    # backend on this database, and this connection is one of them —
    # closing it cleanly now means the eventual checkin never surfaces as
    # a rollback-on-a-dead-connection error once it's gone.
    await db.close()

    async with sessionmaker() as guard:
        await _write_admin_config(guard, {"read_only": True, "pause_workers": True})
        await guard.commit()

    try:
        await _terminate_other_backends_and_dispose(database_url)
        await run_psql_restore(database_url, _SCHEMA_RESET_SQL + dump)
    except (PsqlUnavailable, PsqlFailed) as exc:
        error = f"{type(exc).__name__}: {exc}"
    except Exception as exc:                                    # noqa: BLE001
        logger.exception("db-testing revert failed for session %s", session_id)
        error = f"{type(exc).__name__}: {exc}"

    # The engine was just disposed (inside the call above, on success OR
    # failure — it runs before the restore) — a fresh get_sessionmaker()
    # here, rather than the `sessionmaker` this function was called with,
    # is what actually picks up the new engine instead of quietly running
    # on through the disposed one.
    fresh_sessionmaker = get_sessionmaker()

    async with fresh_sessionmaker() as fin:
        if error is not None:
            # The drop now lives inside the SAME transaction as the
            # restore (see `_SCHEMA_RESET_SQL` above), so a failed restore
            # leaves the database exactly as it was before the attempt:
            # `existing` below is (almost) always found, still 'reverting'.
            # The insert-from-memory branch is a last-resort fallback for
            # a scenario outside psql's own transaction entirely (e.g. the
            # worker process was killed between the terminate call and the
            # restore starting) — read-only stays ON either way.
            existing = await fin.get(DbTestingSession, session_id)
            if existing is None:
                fin.add(DbTestingSession(
                    id=session_id, status="failed", error=error[:ERROR_MAX],
                    row_counts=row_counts, audit_watermark=started_at,
                    started_by=started_by, started_at=started_at,
                    snapshot_backup_id=snapshot_backup_id,
                    previous_banner=previous_banner))
            else:
                existing.status = "failed"
                existing.error = error[:ERROR_MAX]
            audit(fin, actor_id=started_by, entity_type="system",
                  entity_id=str(session_id), action="db_testing.failed",
                  changes={"error": error[:ERROR_MAX]})
            await fin.commit()
            return

        # The snapshot's own db_backups row post-dates the dump — a
        # successful restore genuinely removes it, so re-insert it from
        # the values held in memory. This MUST land (and flush) before the
        # session row below: db_testing_sessions.snapshot_backup_id is a
        # foreign key into db_backups, and the two are plain scalar
        # columns with no ORM relationship() for the unit of work to infer
        # an insert order from — get the dependency order right by hand.
        restored_backup = await fin.get(DbBackup, snapshot_backup_id)
        if restored_backup is None:
            fin.add(DbBackup(
                id=snapshot_backup_id, filename=backup.filename,
                storage_key=backup.storage_key, size_bytes=backup.size_bytes,
                encrypted=backup.encrypted, purpose="testing_snapshot",
                created_by=started_by))
            await fin.flush()

        # A successful restore rewinds the database to dump time: the
        # session's own row comes back as 'snapshotting' (see the module
        # docstring) rather than vanishing, so this is a transition, not
        # an insert, in the common case — the insert branch only fires if
        # something upstream of the dump itself lost the row.
        restored_session = await fin.get(DbTestingSession, session_id)
        ended_at = datetime.now(UTC)
        if restored_session is None:
            restored_session = DbTestingSession(
                id=session_id, started_by=started_by, started_at=started_at)
            fin.add(restored_session)
        restored_session.status = "ended"
        restored_session.ended_with = "reverted"
        restored_session.ended_at = ended_at
        restored_session.error = None
        restored_session.worker_id = None
        restored_session.heartbeat_at = None
        restored_session.snapshot_backup_id = snapshot_backup_id
        restored_session.row_counts = row_counts
        restored_session.audit_watermark = started_at
        restored_session.previous_banner = previous_banner

        # The admin-config banner also post-dates the dump. In a real
        # restore the row already comes back matching `previous_banner`
        # (it's the same content the dump captured, before the snapshot
        # phase's own patch) — this write is explicit anyway rather than
        # relied upon, so the final state never depends on that
        # coincidence holding.
        await _write_admin_config(fin, previous_banner or {
            "read_only": False, "read_only_message": "",
            "pause_workers": False, "banner_enabled": False,
            "banner_message": ""})
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
    # get_sessionmaker(), not the (possibly now-disposed) `sessionmaker`
    # this call was made with — a revert disposes the engine partway
    # through, and this read must land on whatever is current.
    async with get_sessionmaker()() as fresh:
        refreshed = await fresh.get(DbTestingSession, session.id)
        return refreshed.status if refreshed is not None else session.status
