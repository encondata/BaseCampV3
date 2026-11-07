"""Building a subset snapshot: a recipe applied to a source snapshot.

The build runs in the background after POST /seed/recipes/{id}/build has
made its pending Snapshot row, and ends by marking that row ready (with
the stored bundle) or failed (the reason code in notes: never a Postgres
message, which may quote the snapshot's rows, and never a row value).
Its steps, in order:

 1. the source's db.dump is restored into a "build" scratch database;
 2. an empty "subset" scratch database gets the source's schema
    (pg_dump --schema-only | pg_restore), so every constraint, index,
    sequence and extension is there before any row; a schema with triggers
    or rules that would fire during the load or the reset (ENABLE ALWAYS or
    ENABLE REPLICA), or with functions of its own (anything a CHECK, index,
    generated column, domain or default could call), is refused
    (unsafe_schema), see _check_schema;
 3. the kept rows are loaded in one transaction with session_replication_role
    = replica (foreign keys and triggers off, so circular and
    self-referencing links load in any order): All rows tables whole, rows
    tables their ticked plus needed rows, alembic_version whole, every other
    table empty; sequences take the source's positions;
 4. every optional link whose row isn't there is set to NULL;
 5. a required link whose row isn't there fails the build (missing_parent);
 6. with reset_passwords, the reset list (seed/reset.py) is applied and
    read back. The reset clears the listed tables and columns; it can't
    guarantee a source schema hasn't stored secrets elsewhere, which is why
    always/replica triggers and rules, and the schema's own functions, are
    refused in step 2. Then every public table's row count is compared
    with what the loader put there (unexpected_rows otherwise);
 7. the subset is dumped (pg_dump -Fc);
 8. a new objects.tar holds only the kept files, copied member by member
    from the source's (content types as they were);
 9. the source's keys.enc is copied, the manifest is the source's plus
    recipe, source_snapshot, reset_passwords, rows and files;
10. the bundle is stored like any other (snapshots.store_bundle);
11. both scratch databases are dropped, whatever happened (a cancel too).

Rows cross from one scratch database to the other through Sirdar: read
from the build database as its role, written to the subset database as
its role (COPY out, COPY in, streamed). Neither role can reach the other's
database, and the superuser never enters either. Table and column names
only ever come from the catalog; values go as bind parameters."""

import asyncio
import logging
import os
import shutil
import tarfile
import tempfile
import uuid
from contextlib import suppress
from pathlib import Path

import asyncpg

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import SeedRecipe, Snapshot
from sirdar_api.deploy import bundle, snapshots
from sirdar_api.seed import SeedError, recipes, reset, scratch
from sirdar_api.seed import files as seed_files
from sirdar_api.seed.browse import SCHEMA, Table, _catalog, quote
from sirdar_api.seed.closure import ForeignKey, _arrays, _in_keys, foreign_keys

log = logging.getLogger(__name__)

ALEMBIC = "alembic_version"
SCHEMA_DUMP = "schema.dump"
QUEUE_CHUNKS = 16                       # COPY chunks in flight between the two databases

_tasks: dict[uuid.UUID, asyncio.Task] = {}
_source_locks: dict[uuid.UUID, asyncio.Lock] = {}   # one build per source at a time

_SEQUENCES_SQL = """
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY c.relname
"""
# Triggers and rules that fire in replica mode: ENABLE ALWAYS ('A') and
# ENABLE REPLICA ('R'; those fire only then). Constraint triggers are
# internal; a view's _RETURN rule is how a view works.
_UNSAFE_TRIGGERS_SQL = """
SELECT count(*) FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled IN ('A', 'R')
"""
_UNSAFE_RULES_SQL = """
SELECT count(*) FROM pg_rewrite r
JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND r.rulename <> '_RETURN' AND r.ev_enabled IN ('A', 'R')
"""
# Functions, procedures and aggregates of the schema's own (not an
# extension's members, which citext and pg_trgm put in public too).
_UNSAFE_FUNCTIONS_SQL = """
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND NOT EXISTS (
  SELECT 1 FROM pg_depend d
  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
"""
_NOT_NULL_SQL = """
SELECT c.relname, a.attname FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
"""


def _ref(name: str) -> str:
    return f"{quote(SCHEMA)}.{quote(name)}"


def note_of(e: SeedError) -> str:
    """What a failed build's notes say: the code, or the code with its
    detail (missing_parent, reset_target_missing)."""
    return e.extra.get("note") or e.code


# ---- the task ----------------------------------------------------------------------------

def launch(settings: Settings, snapshot_id: uuid.UUID) -> asyncio.Task:
    """Start building pending snapshot `snapshot_id` (committed already)."""
    task = asyncio.create_task(_run(settings, snapshot_id), name=f"seed-build-{snapshot_id}")
    _tasks[snapshot_id] = task

    def done(t: asyncio.Task) -> None:
        _tasks.pop(snapshot_id, None)
        if not t.cancelled() and t.exception() is not None:
            log.error("seed build %s crashed: %s", snapshot_id, type(t.exception()).__name__)

    task.add_done_callback(done)
    return task


def is_active(snapshot_id: uuid.UUID) -> bool:
    return snapshot_id in _tasks


async def wait(snapshot_id: uuid.UUID, timeout: float = 600.0) -> None:
    """Wait for a build running in this process (tests)."""
    task = _tasks.get(snapshot_id)
    if task is not None:
        await asyncio.wait({task}, timeout=timeout)


async def shutdown(timeout: float = 30.0) -> None:
    """App shutdown: every build records itself failed (cancelled) and drops
    its scratch databases."""
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=timeout)


async def recover_orphans() -> int:
    """Startup: a recipe snapshot a previous process left pending has no
    build behind it any more; mark it failed (interrupted). How many."""
    from sqlalchemy import select, update

    async with get_sessionmaker()() as db:
        query = select(Snapshot.id).where(Snapshot.origin == "recipe",
                                          Snapshot.status == "pending")
        if _tasks:
            query = query.where(Snapshot.id.not_in(list(_tasks)))
        ids = list(await db.scalars(query))
        if ids:
            await db.execute(update(Snapshot).where(Snapshot.id.in_(ids))
                             .values(status="failed", notes="interrupted"))
            await db.commit()
        return len(ids)


async def _run(settings: Settings, snapshot_id: uuid.UUID) -> None:
    stored: snapshots.Stored | None = None
    notes = "build_failed"
    try:
        try:
            stored = await _build(settings, snapshot_id)
            notes = ""
        except asyncio.CancelledError:
            notes = "cancelled"
            raise
        except SeedError as e:
            notes = note_of(e)
        except snapshots.SnapshotError as e:
            notes = e.code
        except bundle.BundleError as e:
            log.warning("seed build %s: the bundle couldn't be written or read: %s",
                        snapshot_id, e.reason)
            notes = "bundle_invalid"
        except Exception as e:  # noqa: BLE001 - a background task records, never raises
            log.warning("seed build %s failed: %s", snapshot_id, type(e).__name__)
        if notes:
            log.warning("seed build %s failed: %s", snapshot_id, notes)
    finally:
        await asyncio.shield(_record(settings, snapshot_id, stored, notes))


async def _record(settings: Settings, snapshot_id: uuid.UUID,
                  stored: snapshots.Stored | None, notes: str) -> None:
    """Mark the row ready (with the bundle) or failed (with the reason)."""
    try:
        async with get_sessionmaker()() as db:
            snap = await db.get(Snapshot, snapshot_id)
            if snap is None:                          # gone meanwhile: nothing to keep
                if stored is not None:
                    (snapshots.root(settings) / stored.bundle_file).unlink(missing_ok=True)
                return
            if stored is not None:
                snapshots.mark_ready(snap, stored)
            else:
                snap.status = "failed"
            snap.notes = notes
            await db.commit()
    except Exception as e:  # noqa: BLE001 - nothing left to tell but the log
        log.error("seed build %s couldn't record its outcome: %s", snapshot_id,
                  type(e).__name__)


# ---- the build ------------------------------------------------------------------------

def _work_dir(settings: Settings) -> Path:
    """A private folder in incoming/ (swept at startup like scratch-*)."""
    snapshots.ensure_dirs(settings)
    return Path(tempfile.mkdtemp(prefix="scratch-build-", dir=snapshots.incoming_dir(settings)))


async def _connect(settings: Settings, name: str) -> asyncpg.Connection:
    try:
        return await scratch.connect(settings, name)
    except SeedError:
        raise
    except Exception as e:  # noqa: BLE001 - asyncpg's messages may quote the server
        log.warning("couldn't connect to scratch database %s: %s", name, type(e).__name__)
        raise SeedError("scratch_unavailable") from None


async def _build(settings: Settings, snapshot_id: uuid.UUID) -> snapshots.Stored:
    async with get_sessionmaker()() as db:
        snap = await db.get(Snapshot, snapshot_id)
        if snap is None:
            raise SeedError("snapshot_not_found")
        recipe = await db.get(SeedRecipe, snap.recipe_id) if snap.recipe_id else None
        source = (await db.get(Snapshot, snap.source_snapshot_id)
                  if snap.source_snapshot_id else None)
        if recipe is None:
            raise SeedError("recipe_not_found")
        if source is None:
            raise SeedError("snapshot_not_found")
        detail = await recipes.detail(db, recipe)
        reset_passwords = bool(snap.reset_passwords)
    extra = {"recipe": {"id": str(recipe.id), "name": recipe.name},
             "source_snapshot": {"id": str(source.id), "name": source.name},
             "reset_passwords": reset_passwords}

    async with _source_locks.setdefault(source.id, asyncio.Lock()):
        build_db = subset_db = None
        work = await asyncio.to_thread(_work_dir, settings)
        try:
            build_db = await scratch.ensure_restored(settings, source, purpose="build")
            subset_db = await scratch.create_blank(settings, snapshot_id, "subset")
            await _copy_schema(settings, build_db, subset_db, work)
            src = await _connect(settings, build_db)
            try:
                dst = await _connect(settings, subset_db)
                try:
                    await _check_schema(dst)
                    kept = await seed_files.kept_rows(src, detail["tables"])
                    rows = await _load(src, dst, kept)
                    await _fix_links(dst)
                    if reset_passwords:
                        await _reset(dst)
                        # The emptied tables keep no rows now: not in the
                        # manifest, and their files don't follow them.
                        rows = {t: n for t, n in rows.items() if t not in reset.EMPTY_TABLES}
                        kept = {t: v for t, v in kept.items() if t not in reset.EMPTY_TABLES}
                    await _verify_counts(src, dst, rows)
                    refs = await seed_files.referenced(src, kept)
                finally:
                    await dst.close()
            finally:
                await src.close()
            objects = await seed_files.objects_for(settings, source)
            keep = seed_files.kept_keys(objects, refs, detail["files"])
            await _dump(settings, subset_db, work / bundle.DB_DUMP)
            manifest = await asyncio.to_thread(_write_parts, settings, source, work, set(keep))
            out = work / "bundle.tar.gz"
            await asyncio.to_thread(
                bundle.pack, out, source=manifest["source"],
                revision=manifest["alembic_revision"], bucket=manifest["bucket"],
                db_dump=work / bundle.DB_DUMP, objects_tar=work / bundle.OBJECTS,
                keys_file=work / bundle.KEYS_ENC,
                extra={**extra, "rows": rows, "files": len(keep)})
            return await asyncio.to_thread(snapshots.store_bundle, settings, out, snapshot_id)
        finally:
            for name in (subset_db, build_db):
                if name is not None:
                    try:
                        await asyncio.shield(scratch.drop(settings, name))
                    except Exception as e:  # noqa: BLE001 - the sweep gets what's left
                        log.warning("couldn't drop scratch database %s: %s", name,
                                    type(e).__name__)
            await asyncio.to_thread(shutil.rmtree, work, True)


def _tool_failed(tool: str, step: str, code: int, err: str) -> SeedError:
    # stderr may quote rows: the log only, never the notes.
    first = next((ln for ln in err.splitlines() if ln.strip()), "")[:300]
    log.warning("%s during a seed build (%s) exited with %d: %s", tool, step, code, first)
    return SeedError(step)


async def _copy_schema(settings: Settings, build_db: str, subset_db: str, work: Path) -> None:
    """The source's schema (no rows, no owners, no grants) into the subset."""
    dump = work / SCHEMA_DUMP
    code, err = await scratch.run_tool(
        settings, "pg_dump", ["-Fc", "--schema-only", "--no-owner", "--no-privileges", build_db],
        role=build_db, stdout_path=dump)
    if code != 0:
        raise _tool_failed("pg_dump", "schema_copy_failed", code, err)
    code, err = await scratch.run_tool(
        settings, "pg_restore",
        ["--no-owner", "--no-privileges", "--dbname", subset_db, str(dump)], role=subset_db)
    if code != 0:
        raise _tool_failed("pg_restore", "schema_copy_failed", code, err)
    dump.unlink(missing_ok=True)


async def _dump(settings: Settings, subset_db: str, out: Path) -> None:
    code, err = await scratch.run_tool(
        settings, "pg_dump", ["-Fc", "--no-owner", "--no-privileges", subset_db],
        role=subset_db, stdout_path=out)
    if code != 0:
        raise _tool_failed("pg_dump", "dump_failed", code, err)


async def _check_schema(dst: asyncpg.Connection) -> None:
    """Refuse a schema that could act during the load or the reset. The
    rows go in, the links are fixed and the secrets cleared with
    session_replication_role = replica, which silences ordinary triggers
    and rules, but not ENABLE ALWAYS ones, and ENABLE REPLICA ones fire
    only then; and a function of the schema's own can run during the load
    from a CHECK constraint, an index expression, a generated column, a
    domain or a column default. Either way a crafted dump could copy a
    row's password hash into another kept table as it is loaded or reset,
    where the read-back can't see it. So any such trigger or rule, and any
    function that isn't an extension's (ServerSherpa defines none), fails
    the build (unsafe_schema), whether or not passwords are being reset."""
    try:
        fired = (await dst.fetchval(_UNSAFE_TRIGGERS_SQL, SCHEMA)
                 + await dst.fetchval(_UNSAFE_RULES_SQL, SCHEMA))
        functions = await dst.fetchval(_UNSAFE_FUNCTIONS_SQL, SCHEMA)
    except asyncpg.PostgresError as e:
        log.warning("checking a subset's schema failed: %s", type(e).__name__)
        raise SeedError("load_failed") from None
    if fired or functions:
        raise SeedError("unsafe_schema",
                        note=f"unsafe_schema: {fired} always/replica triggers or rules, "
                             f"{functions} functions")


async def _verify_counts(src: asyncpg.Connection, dst: asyncpg.Connection,
                         expected: dict[str, int]) -> None:
    """Defense in depth, once the links are fixed and the reset done: every
    public table of the subset holds exactly the rows the loader put there
    (none, for a table it didn't load or the reset emptied). A table with
    other rows fails the build (unexpected_rows)."""
    names = [t.name for t in await _catalog(dst)]
    if await dst.fetchval("SELECT to_regclass($1)", f"{SCHEMA}.{ALEMBIC}") is not None:
        names.append(ALEMBIC)
    try:
        for name in sorted(names):
            actual = await dst.fetchval(f"SELECT count(*) FROM {_ref(name)}")
            if actual != expected.get(name, 0):
                log.warning("a subset's table %s holds %d row(s), %d were loaded", name,
                            actual, expected.get(name, 0))
                raise SeedError("unexpected_rows", note=f"unexpected_rows: {name}")
    except asyncpg.PostgresError as e:
        log.warning("counting a subset's rows failed: %s", type(e).__name__)
        raise SeedError("load_failed") from None


# ---- loading -----------------------------------------------------------------------------

async def _copy(src: asyncpg.Connection, dst: asyncpg.Connection, table: str,
                columns: list[str] | None, sql: str, args: list) -> int:
    """Stream the rows `sql` selects on `src` into `table` on `dst` (text
    COPY, chunk by chunk, nothing on disk); how many rows. Text, not
    binary: binary COPY carries type OIDs (an enum array's element type,
    a composite's), which differ between two databases even with the same
    schema."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_CHUNKS)

    async def sink(data) -> None:
        await queue.put(bytes(data))

    async def produce() -> None:
        try:
            await src.copy_from_query(sql, *args, output=sink, format="text")
        finally:
            await queue.put(None)

    async def chunks():
        while (chunk := await queue.get()) is not None:
            yield chunk

    producer = asyncio.create_task(produce())
    try:
        status = await dst.copy_to_table(table, source=chunks(), columns=columns,
                                         schema_name=SCHEMA, format="text")
    except BaseException:
        producer.cancel()
        with suppress(BaseException):
            await producer
        # A failed read ends the stream short, which fails the write too:
        # the read's error is the one that says why.
        if producer.done() and not producer.cancelled() and producer.exception() is not None:
            raise producer.exception() from None
        raise
    await producer                                # its own failure, if any
    return int(status.rsplit(" ", 1)[-1])


def _rows_sql(t: Table, rows) -> tuple[str, list]:
    cols = ", ".join(f"c.{quote(c.name)}" for c in t.columns)
    sql = f"SELECT {cols} FROM {_ref(t.name)} c"
    if rows == "all":
        return sql, []
    return sql + " WHERE " + _in_keys("c", t.pk, 1), _arrays(rows, len(t.pk))


async def _load(src: asyncpg.Connection, dst: asyncpg.Connection, kept: dict) -> dict[str, int]:
    """Load the kept rows into the subset, foreign keys and triggers off
    for the transaction (session_replication_role = replica, which the
    subset's own role may set), then the sequences' positions; the rows
    copied per table."""
    catalog = {t.name: t for t in await _catalog(src)}
    for name in kept:
        if name not in catalog:
            raise SeedError("table_not_found")
    counts: dict[str, int] = {}
    try:
        async with dst.transaction():
            await dst.execute("SET LOCAL session_replication_role = replica")
            if await src.fetchval("SELECT to_regclass($1)", f"{SCHEMA}.{ALEMBIC}") is not None:
                counts[ALEMBIC] = await _copy(src, dst, ALEMBIC, None,
                                              f"SELECT * FROM {_ref(ALEMBIC)}", [])
            for name in sorted(kept):
                rows = kept[name]
                if rows != "all" and not rows:
                    continue
                t = catalog[name]
                sql, args = _rows_sql(t, rows)
                counts[name] = await _copy(src, dst, name, [c.name for c in t.columns], sql, args)
        await _sync_sequences(src, dst)
    except asyncpg.PostgresError as e:
        log.warning("loading a subset failed: %s", type(e).__name__)
        raise SeedError("load_failed") from None
    return counts


async def _sync_sequences(src: asyncpg.Connection, dst: asyncpg.Connection) -> None:
    """Every public sequence of the subset takes the source's position, so
    rows added to the new environment never collide with copied ones."""
    for r in await src.fetch(_SEQUENCES_SQL, SCHEMA):
        name = r["relname"]
        if await dst.fetchval("SELECT to_regclass($1)", f"{SCHEMA}.{name}") is None:
            continue
        state = await src.fetchrow(f"SELECT last_value, is_called FROM {_ref(name)}")
        await dst.execute("SELECT setval($1::regclass, $2, $3)", _ref(name),
                          state["last_value"], state["is_called"])


# ---- links ------------------------------------------------------------------------------

def _orphans(fk: ForeignKey) -> str:
    """`WHERE <every link column set> AND no row of the parent matches`."""
    present = " AND ".join(f"c.{quote(cc)} IS NOT NULL" for cc in fk.columns)
    match = " AND ".join(f"p.{quote(rc)} = c.{quote(cc)}"
                         for cc, rc in zip(fk.columns, fk.ref_columns, strict=True))
    return (f"WHERE {present} AND NOT EXISTS "
            f"(SELECT 1 FROM {_ref(fk.ref_table)} p WHERE {match})")


async def _fix_links(dst: asyncpg.Connection) -> None:
    """Optional links to rows that aren't there come over empty; a required
    one still pointing nowhere fails the build, naming the row. Only links
    between two public tables are verified (what closure follows and the
    load copies; ServerSherpa has nothing outside public). The UPDATEs run
    with the schema's triggers off (replica), like the load: the dump is
    untrusted, and a trigger of its own must not undo the NULLs."""
    try:
        catalog = {t.name: t for t in await _catalog(dst)}
        links = await foreign_keys(dst)
        not_null = {(r["relname"], r["attname"]) for r in await dst.fetch(_NOT_NULL_SQL, SCHEMA)}
        async with dst.transaction():
            await dst.execute("SET LOCAL session_replication_role = replica")
            for fk in links:
                if fk.required:
                    continue
                cols = [c for c in fk.columns if (fk.table, c) not in not_null]
                sets = ", ".join(f"{quote(c)} = NULL" for c in cols)
                await dst.execute(f"UPDATE {_ref(fk.table)} c SET {sets} {_orphans(fk)}")
        for fk in links:
            if not fk.required:
                continue
            t = catalog[fk.table]
            keys = ", ".join(f"c.{quote(k)}::text" for k in t.pk) if t.pk else "NULL"
            row = await dst.fetchrow(f"SELECT {keys} FROM {_ref(fk.table)} c {_orphans(fk)} "
                                     "LIMIT 1")
            if row is not None:
                pk = ", ".join(str(v) for v in row.values()) if t.pk else "a row"
                raise SeedError("missing_parent",
                                note=f"missing_parent: {fk.table} {pk} needs {fk.ref_table}")
    except asyncpg.PostgresError as e:
        log.warning("checking a subset's links failed: %s", type(e).__name__)
        raise SeedError("load_failed") from None


# ---- the reset list ----------------------------------------------------------------------

async def _reset(dst: asyncpg.Connection) -> None:
    """Apply seed/reset.py; a listed table or column the subset lacks fails
    the build first (reset_target_missing), before anything changes."""
    catalog = {t.name: t for t in await _catalog(dst)}
    user = catalog.get(reset.USER_TABLE)
    if user is None:
        raise SeedError("reset_target_missing",
                        note=f"reset_target_missing: {reset.USER_TABLE}")
    have = {c.name for c in user.columns}
    for col in reset.USER_COLUMNS:
        if col not in have:
            raise SeedError("reset_target_missing",
                            note=f"reset_target_missing: {reset.USER_TABLE}.{col}")
    for name in reset.EMPTY_TABLES:
        if name not in catalog:
            raise SeedError("reset_target_missing", note=f"reset_target_missing: {name}")
    cols = list(reset.USER_COLUMNS)
    values = [reset.USER_COLUMNS[c] for c in cols]
    sets = ", ".join(f"{quote(c)} = ${i + 1}" for i, c in enumerate(cols))
    # A row the reset missed: a column meant to be NULL that isn't, or one
    # meant to hold a value that holds another.
    checks, wanted = [], []
    for c, v in zip(cols, values, strict=True):
        if v is None:
            checks.append(f"{quote(c)} IS NOT NULL")
        else:
            wanted.append(v)
            checks.append(f"{quote(c)} IS DISTINCT FROM ${len(wanted)}")
    missed = " OR ".join(checks)
    try:
        async with dst.transaction():
            # The dump is untrusted: its triggers stay off (replica) while the
            # secrets go, as during the load.
            await dst.execute("SET LOCAL session_replication_role = replica")
            await dst.execute(f"UPDATE {_ref(reset.USER_TABLE)} SET {sets}", *values)
            for name in reset.EMPTY_TABLES:
                await dst.execute(f"DELETE FROM {_ref(name)}")
        # Then read it back: an ALWAYS rule of the dump's (replica mode
        # switches off ordinary rules and triggers, not those) could have
        # rewritten the statements. Nothing ships unless every secret is gone.
        left = await dst.fetchval(
            f"SELECT count(*) FROM {_ref(reset.USER_TABLE)} WHERE {missed}", *wanted)
        for name in reset.EMPTY_TABLES:
            left += await dst.fetchval(f"SELECT count(*) FROM {_ref(name)}")
    except asyncpg.PostgresError as e:
        log.warning("resetting a subset's passwords failed: %s", type(e).__name__)
        raise SeedError("reset_failed") from None
    if left:
        log.warning("resetting a subset's passwords left %d row(s) unchanged", left)
        raise SeedError("reset_failed")


# ---- the bundle's other parts ------------------------------------------------------------

def _write_parts(settings: Settings, source: Snapshot, work: Path, keep: set[str]) -> dict:
    """One pass over the source bundle (every checksum checked): its
    keys.enc copied into `work`, and a new objects.tar there holding only
    the members in `keep`, each as the source stored it (name, size, mtime,
    content type). The source's manifest. Sync: run it in a thread."""
    path = snapshots.bundle_path(settings, source)
    if not path.is_file():
        raise snapshots.SnapshotError("snapshot_file_missing")
    out = work / bundle.OBJECTS

    def on_keys(name: str, data: bytes) -> None:
        if name != bundle.KEYS_ENC:
            raise bundle.BundleError("The source snapshot's keys aren't encrypted.")
        with os.fdopen(bundle._open_private(work / bundle.KEYS_ENC), "wb") as f:
            f.write(data)

    def on_data(name: str, size: int, reader) -> None:
        if name != bundle.OBJECTS:
            return
        with os.fdopen(bundle._open_private(out), "wb") as raw, \
                tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar, \
                tarfile.open(fileobj=reader, mode="r|", tarinfo=bundle._SafeInfo) as src:
            for member in src:
                if not member.isfile() or member.name not in keep:
                    continue
                info = bundle._member(member.name, member.size, member.mtime)
                content_type = member.pax_headers.get(bundle.CONTENT_TYPE_HEADER)
                if content_type:
                    info.pax_headers = {bundle.CONTENT_TYPE_HEADER: content_type}
                tar.addfile(info, src.extractfile(member))

    manifest, _, _ = bundle._scan(path, on_keys=on_keys, on_data=on_data,
                                  max_bytes=4 * settings.snapshot_max_bytes)
    return manifest
