"""Database health (Dev -> Database -> Health): read-only Postgres catalog
queries. Nothing here returns the host, a user or role name, a password,
query text or a client address."""

import time
from datetime import UTC, datetime

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from serversherpa.db.engine import get_engine
from serversherpa.db.ordering import natural_key
from serversherpa.services import storage

OTHER_APP = "Other"     # connections that never set an application_name


async def summary(db: AsyncSession) -> dict:
    # round-trip of the cheapest possible statement, measured from here
    started = time.perf_counter()
    await db.execute(text("SELECT 1"))
    latency_ms = (time.perf_counter() - started) * 1000

    row = (await db.execute(text("""
        SELECT pg_database_size(current_database()) AS size,
               current_setting('server_version') AS version,
               pg_postmaster_start_time() AS started_at,
               (SELECT count(*) FROM pg_stat_activity
                 WHERE backend_type = 'client backend') AS connections,
               current_setting('max_connections')::int AS max_connections,
               (SELECT blks_hit FROM pg_stat_database
                 WHERE datname = current_database()) AS blks_hit,
               (SELECT blks_read FROM pg_stat_database
                 WHERE datname = current_database()) AS blks_read
    """))).one()
    reads = (row.blks_hit or 0) + (row.blks_read or 0)
    return {
        "database_size_bytes": int(row.size),
        # "16.4 (Homebrew)" and "16.4 (Debian 16.4-1.pgdg120+1)" -> "16.4"
        "version": row.version.split()[0],
        "started_at": row.started_at,
        "latency_ms": round(latency_ms, 2),
        "connections": int(row.connections),
        "max_connections": row.max_connections,
        "cache_hit_ratio": (row.blks_hit / reads) if reads else None,
    }


async def connections(db: AsyncSession) -> list[dict]:
    """Backends on this database grouped by application name and state,
    leaving out the backend serving this request."""
    rows = (await db.execute(text("""
        SELECT coalesce(nullif(application_name, ''), :other) AS app,
               coalesce(state, 'unknown') AS state,
               count(*) AS count,
               max(extract(epoch FROM now() - query_start))
                   FILTER (WHERE state = 'active') AS oldest_query_seconds,
               max(extract(epoch FROM now() - xact_start))
                   FILTER (WHERE xact_start IS NOT NULL) AS oldest_transaction_seconds,
               count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_on_lock
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND backend_type = 'client backend'
           AND pid <> pg_backend_pid()
         GROUP BY 1, 2
    """), {"other": OTHER_APP})).all()
    groups = [{
        "application_name": r.app,
        "state": r.state,
        "count": int(r.count),
        "oldest_query_seconds": None if r.oldest_query_seconds is None
        else float(r.oldest_query_seconds),
        "oldest_transaction_seconds": None if r.oldest_transaction_seconds is None
        else float(r.oldest_transaction_seconds),
        "waiting_on_lock": int(r.waiting_on_lock),
    } for r in rows]
    groups.sort(key=lambda g: (natural_key(g["application_name"]), g["state"]))
    return groups


class UnknownTable(Exception):
    """The name isn't one of the current public tables."""


class TableBusy(Exception):
    """Another session holds a lock that VACUUM would have to wait behind."""


# How long VACUUM may wait for a conflicting lock before giving up. Tests lower it.
VACUUM_LOCK_TIMEOUT = "10s"
LOCK_NOT_AVAILABLE = "55P03"


_TABLE_STATS_SQL = """
    SELECT relname AS name,
           n_live_tup AS rows,
           pg_total_relation_size(relid) AS total_bytes,
           pg_relation_size(relid) AS table_bytes,
           pg_indexes_size(relid) AS index_bytes,
           n_dead_tup AS dead_rows,
           CASE WHEN n_live_tup + n_dead_tup = 0 THEN NULL
                ELSE n_dead_tup::float8 / (n_live_tup + n_dead_tup) END AS dead_ratio,
           greatest(last_vacuum, last_autovacuum) AS last_vacuum_at,
           greatest(last_analyze, last_autoanalyze) AS last_analyze_at
      FROM pg_stat_user_tables
     WHERE schemaname = 'public'
"""


async def _table_stats(conn: AsyncSession | AsyncConnection, name: str | None = None) -> list[dict]:
    sql = _TABLE_STATS_SQL
    params: dict = {}
    if name is not None:
        sql += " AND relname = :name"
        params["name"] = name
    sql += " ORDER BY pg_total_relation_size(relid) DESC, relname"
    rows = (await conn.execute(text(sql), params)).all()
    return [{
        "name": r.name,
        "rows": int(r.rows),
        "total_bytes": int(r.total_bytes),
        "table_bytes": int(r.table_bytes),
        "index_bytes": int(r.index_bytes),
        "dead_rows": int(r.dead_rows),
        "dead_ratio": None if r.dead_ratio is None else float(r.dead_ratio),
        "last_vacuum_at": r.last_vacuum_at,
        "last_analyze_at": r.last_analyze_at,
    } for r in rows]


async def tables(db: AsyncSession) -> list[dict]:
    """Every public table with its size and vacuum figures, biggest first."""
    return await _table_stats(db)


async def vacuum_table(name: str) -> dict:
    """VACUUM (ANALYZE) one public table. `name` is only ever compared with
    the catalog; what gets quoted into the statement is the name the catalog
    returned. VACUUM can't run inside a transaction, hence the autocommit
    connection."""
    async with get_engine().connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        known = await conn.scalar(text(
            "SELECT relname FROM pg_stat_user_tables "
            "WHERE schemaname = 'public' AND relname = :name"), {"name": name})
        if known is None:
            raise UnknownTable(name)
        quoted = conn.dialect.identifier_preparer.quote(known)
        started = time.perf_counter()
        # session-level, so it is reset below: the connection goes back to the pool
        await conn.exec_driver_sql(f"SET lock_timeout = '{VACUUM_LOCK_TIMEOUT}'")
        try:
            # exec_driver_sql, not text(): a ':word' in an identifier must not
            # be read as a bind parameter
            await conn.exec_driver_sql(f"VACUUM (ANALYZE) public.{quoted}")
        except DBAPIError as exc:
            sqlstate = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
            if sqlstate == LOCK_NOT_AVAILABLE:
                raise TableBusy(known) from None
            raise
        finally:
            try:
                await conn.exec_driver_sql("RESET lock_timeout")
            except DBAPIError:      # a dead connection must not mask the real outcome
                await conn.invalidate()
        duration_ms = round((time.perf_counter() - started) * 1000)
        (stats,) = await _table_stats(conn, known)
    return {"table": stats, "duration_ms": duration_ms}


ROOT_FOLDER = "(root)"      # objects whose key has no "/"

# What a storage listing can raise: botocore's own errors (ClientError and
# EndpointConnectionError are both BotoCoreError/ClientError subclasses) and
# the socket/TLS failures under them.
STORAGE_ERRORS = (ClientError, BotoCoreError, OSError)


async def storage_usage() -> dict:
    """Object count and bytes per top-level folder of the bucket. Lists
    every object, so it can take a while on a big bucket — on demand only."""
    folders: dict[str, dict] = {}

    def visit(key: str, size: int) -> None:
        # a key with no "/" -- or one that starts with it, whose first
        # segment would be "" -- belongs to no folder
        name = key.split("/", 1)[0] if "/" in key else ""
        name = name or ROOT_FOLDER
        folder = folders.setdefault(name, {"name": name, "objects": 0, "bytes": 0})
        folder["objects"] += 1
        folder["bytes"] += size

    await storage.scan_objects(visit)
    rows = sorted(folders.values(), key=lambda f: (-f["bytes"], natural_key(f["name"])))
    return {
        "folders": rows,
        "total_objects": sum(f["objects"] for f in rows),
        "total_bytes": sum(f["bytes"] for f in rows),
        "measured_at": datetime.now(UTC),
    }
