"""Database health (Dev -> Database -> Health): read-only Postgres catalog
queries. Nothing here returns the host, a user or role name, a password,
query text or a client address."""

import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.ordering import natural_key

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
