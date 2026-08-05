"""Pins conftest's seeded vocabulary colours to migration 0013's own maps.

`clean_db` (conftest.py, autouse=True) unconditionally rewrites `color` for
every status, site type and worker level BEFORE EVERY TEST, using hex
literals it hardcodes itself. That means every other test asserting a
migrated colour — test_status_tokens_mapped_to_their_light_hex,
test_site_types_seeded_with_hex, test_worker_levels_keep_their_existing_badge_colors,
test_site_statuses_migrated_with_colors — reads conftest's literals back, not
0013's output. Change TOKEN_HEX in the migration and all 271 tests still pass;
it deploys, every green chip turns black, CI stayed green throughout.

This file closes that gap the other direction: instead of duplicating a THIRD
copy of the hex values (which could itself drift from both conftest and the
migration without anything noticing), it reads the values clean_db actually
put in the database and compares them against 0013's own TOKEN_HEX /
SITE_TYPE_HEX / LEVEL_HEX dicts, imported live from the migration file. If
conftest's literals and the migration's maps ever disagree — in either
direction — one of the asserts below fails.

We deliberately don't touch conftest.py's fixture to *source* its seed colours
from these same dicts (which would make agreement automatic rather than
merely tested): that fixture gates all 271 tests, and round-tripping through
the DB here gets the same "cannot drift silently" guarantee with far less
blast radius.

Alembic version files have no `__init__.py` (they're not a package — alembic
loads them dynamically), so a plain `import` doesn't work; the migration is
loaded by file path instead, per Python's documented recipe for importing a
module that isn't on the import path.
"""

import importlib.util
from pathlib import Path

from sqlalchemy import select

from serversherpa.db.models import SiteType, StatusValue, WorkerLevel

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0013_vocabulary_colors.py"
)


def _load_migration_0013():
    spec = importlib.util.spec_from_file_location("_migration_0013_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None, (
        f"could not build an import spec for {MIGRATION_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_module_loads_by_file_path():
    """Sanity check on the loading mechanism itself, independent of the DB
    tests below — if this fails, every other test in this file is
    meaningless (they'd all be skipped/erroring for the wrong reason)."""
    migration = _load_migration_0013()
    assert migration.TOKEN_HEX["c-green"] == "#178a4c"
    assert migration.SITE_TYPE_HEX["datacenter"] == "#1668a7"
    assert migration.LEVEL_HEX["L1"] == "#8a93a6"


# Which CSS token 0013 mapped each status onto. TOKEN_HEX is keyed by token
# name, not by (record_type, key) — this is the piece of knowledge that lets
# conftest's per-status hex literals be checked against it at all. Matches
# the "# was c-green" comments in test_status_values_model.py /
# test_vocabulary_colors_model.py.
STATUS_TOKEN = {
    ("site", "active"): "c-green",
    ("site", "planned"): "c-aqua",
    ("site", "inactive"): "c-slate",
    ("site", "decommissioned"): "c-red",
    ("worker", "active"): "c-green",
    ("worker", "standby"): "c-amber",
    ("worker", "blacklist"): "c-red",
}


async def test_seeded_status_colors_match_migration_token_hex(db):
    migration = _load_migration_0013()
    rows = {(r.record_type, r.key): r.color
            for r in await db.scalars(select(StatusValue))}
    assert rows.keys() == STATUS_TOKEN.keys(), (
        "conftest's seeded statuses and this test's token map have drifted apart")
    for status_key, token in STATUS_TOKEN.items():
        assert rows[status_key] == migration.TOKEN_HEX[token], (
            f"{status_key} is seeded as {rows[status_key]!r}, but 0013 maps "
            f"{token!r} -> {migration.TOKEN_HEX[token]!r}")


async def test_seeded_site_type_colors_match_migration_site_type_hex(db):
    migration = _load_migration_0013()
    rows = {r.key: r.color for r in await db.scalars(select(SiteType))}
    assert rows.keys() == migration.SITE_TYPE_HEX.keys()
    for key, hex_value in migration.SITE_TYPE_HEX.items():
        assert rows[key] == hex_value, (
            f"site type {key!r} is seeded as {rows[key]!r}, but 0013 seeds it {hex_value!r}")


async def test_seeded_worker_level_colors_match_migration_level_hex(db):
    migration = _load_migration_0013()
    rows = {r.level: r.color for r in await db.scalars(select(WorkerLevel))}
    assert rows.keys() == migration.LEVEL_HEX.keys()
    for level, hex_value in migration.LEVEL_HEX.items():
        assert rows[level] == hex_value, (
            f"level {level!r} is seeded as {rows[level]!r}, but 0013 seeds it {hex_value!r}")
