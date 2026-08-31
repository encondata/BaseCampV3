# V2 Status-Rules Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the 13 translatable live V2 process-engine rules from the V2 SQL backup into V3's `status_rules` tables via a re-runnable CLI command, adding three typed catalog actions (plus one param) so they translate at full fidelity.

**Architecture:** Catalog/context additions first (they're what the imported rules execute), then a parser+translator module reusing the house dump parser (`sites/v2_import.insert_rows`), then the typer command. Upsert by rule name; first inserts land disabled.

**Spec:** `docs/superpowers/specs/2026-08-31-v2-status-rules-import-design.md` — read before starting any task.

**Tech Stack:** Python/SQLAlchemy async/typer. No new dependencies. No portal work (the editor is schema-driven and picks up new actions automatically). No migrations.

## Global Constraints

- **Run all test suites FOREGROUND in one continuous run with timeout 600000ms. Never background a suite.**
- API tests: `api/.venv/bin/pytest api/tests/<file> -v` from repo root (Postgres via `docker compose -f docker-compose.dev.yml up -d`).
- Never commit `api/src/serversherpa/_dev_reload.py` — `git checkout -- api/src/serversherpa/_dev_reload.py` before each commit if churned.
- Importable rules are exactly those with `trigger_table = 'moves_assets_list'`; everything else (trucks, containers) is skipped with a printed reason.
- First-time inserts get `enabled = false`; re-runs preserve the rule's current `enabled` flag.
- The real backup is `api/backups/backup_20260825_193157.sql`; expected real-world result: 13 imported, 3 skipped.
- House comment style: comments state constraints, no narration.

## File Structure

| File | Responsibility |
|---|---|
| `api/src/serversherpa/status_rules/catalog.py` | Modify: +3 actions, `fields` param on `set_asset_location_from_scan` |
| `api/src/serversherpa/status_rules/engine.py` | Modify: containment resolution in `_build_context` |
| `api/src/serversherpa/status_rules/v2_import.py` | Create: dump parsing, translation maps, upsert |
| `api/src/serversherpa/cli.py` | Modify: +`import-v2-status-rules` command |
| `api/tests/test_status_rules_catalog.py` | Modify: new-action + fields-param tests |
| `api/tests/test_status_rules_engine.py` | Modify: containment-context test |
| `api/tests/test_status_rules_v2_import.py` | Create: translation/upsert/e2e tests |

---

### Task 1: Catalog additions — three actions + `fields` param

**Files:**
- Modify: `api/src/serversherpa/status_rules/catalog.py`
- Test: `api/tests/test_status_rules_catalog.py` (append)

**Interfaces:**
- Produces action keys consumed by Task 3's translator (exact strings): `clear_asset_location`, `clear_asset_site`, `set_asset_location_from_container` (all zero-param), and `set_asset_location_from_scan` now taking `{"fields": "site"|"location"|"both"}` (required in the param schema; apply-time default `"both"` when absent).
- `set_asset_location_from_container` reads `ctx.container` (Task 2 populates it for asset matches); skip reason is exactly `not_in_container`.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_status_rules_catalog.py`; the file already has `_scan`, `Context`, `ACTIONS`, `validate_action` imports — reuse them):

```python
async def test_clear_actions(db):
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="R4 RU10", site_id=site.id)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)
    out = await ACTIONS["clear_asset_location"].apply(db, ctx, {})
    assert out.applied is True
    assert a.location_detail == ""
    out = await ACTIONS["clear_asset_site"].apply(db, ctx, {})
    assert out.applied is True
    assert a.site_id is None


async def test_set_asset_location_from_container(db):
    a = Asset()
    c = Container(name="scan-verify-crate")
    db.add_all([a, c])
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a, container=c)
    out = await ACTIONS["set_asset_location_from_container"].apply(db, ctx, {})
    assert out.applied is True
    assert a.location_detail == "scan-verify-crate"

    bare = Context(scan=scan, asset=a)          # not in any container
    out = await ACTIONS["set_asset_location_from_container"].apply(db, bare, {})
    assert out.applied is False
    assert out.reason == "not_in_container"


async def test_location_from_scan_fields_param(db):
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="R4 RU10", site_id=None)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a, site_id=site.id, location_detail="")
    ctx = Context(scan=scan, asset=a)

    out = await ACTIONS["set_asset_location_from_scan"].apply(
        db, ctx, {"fields": "site"})
    assert out.applied is True
    assert a.site_id == site.id
    assert a.location_detail == "R4 RU10"       # untouched — the V2 fidelity point

    out = await ACTIONS["set_asset_location_from_scan"].apply(
        db, ctx, {"fields": "location"})
    assert a.location_detail == ""

    a.location_detail = "R4 RU10"
    out = await ACTIONS["set_asset_location_from_scan"].apply(db, ctx, {})
    assert a.location_detail == ""              # empty params default to both


def test_validate_new_actions():
    assert validate_action("clear_asset_location", {}) is None
    assert validate_action("clear_asset_site", {}) is None
    assert validate_action("set_asset_location_from_container", {}) is None
    assert validate_action("set_asset_location_from_scan",
                           {"fields": "site"}) is None
    assert validate_action("set_asset_location_from_scan",
                           {"fields": "sideways"}) == "bad_param"
    assert validate_action("set_asset_location_from_scan", {}) == "missing_param"
```

Add `Site` to the test file's models import if missing.

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_catalog.py -v`
Expected: new tests FAIL with `KeyError: 'clear_asset_location'` etc.; existing tests still pass.

- [ ] **Step 3: Implement.** In `api/src/serversherpa/status_rules/catalog.py`:

Replace `_set_asset_location_from_scan` with:

```python
async def _set_asset_location_from_scan(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    # Older rows may predate the fields param — absent means both.
    fields = params.get("fields", "both")
    if fields in ("site", "both"):
        ctx.asset.site_id = ctx.scan.site_id
    if fields in ("location", "both"):
        ctx.asset.location_detail = ctx.scan.location_detail
    _touch(ctx.asset)
    return ActionOutcome(True)
```

Add three apply functions after `_touch_container_audit`:

```python
async def _clear_asset_location(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.location_detail = ""
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _clear_asset_site(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.site_id = None
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_asset_location_from_container(db, ctx, params) -> ActionOutcome:
    """ctx.container is the asset's CONTAINING container for asset
    matches (resolved by the engine); required here."""
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    if ctx.container is None:
        return ActionOutcome(False, "not_in_container")
    ctx.asset.location_detail = ctx.container.name
    _touch(ctx.asset)
    return ActionOutcome(True)
```

In `_ACTION_LIST`: change the `set_asset_location_from_scan` entry's params to
`(ParamField("fields", "choice", options=("site", "location", "both")),)`
and append:

```python
    ActionDef("clear_asset_location", "Clear asset location", (),
              _clear_asset_location),
    ActionDef("clear_asset_site", "Clear asset site", (),
              _clear_asset_site),
    ActionDef("set_asset_location_from_container",
              "Set asset location from its container", (),
              _set_asset_location_from_container),
```

- [ ] **Step 4: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_catalog.py api/tests/test_status_rules_api.py -v`
Expected: all pass (the API schema test only asserts operator count and non-empty options, so the new actions don't break it — if a test pins the exact action list, update its expectation to include the three new keys).

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules/catalog.py api/tests/test_status_rules_catalog.py
git commit -m "feat(api): catalog actions for V2 parity — clears, container location, scan-fields param"
```

---

### Task 2: Engine context — containment resolution for asset matches

**Files:**
- Modify: `api/src/serversherpa/status_rules/engine.py` (`_build_context`)
- Test: `api/tests/test_status_rules_engine.py` (append)

**Interfaces:**
- Consumes: `ContainerAsset`/`Container` models (existing; `container_assets.asset_id` is UNIQUE).
- Produces: for `match_type == "asset"`, `ctx.container` = the asset's containing container or None. Container matches unchanged.

- [ ] **Step 1: Write the failing test** (append; the file already has `Asset`, `_asset_scan`, `_rule` helpers — add `Container, ContainerAsset` to its models import):

```python
async def test_asset_context_resolves_containing_container(db):
    a = Asset()
    c = Container(name="crate-7")
    db.add_all([a, c])
    await db.flush()
    db.add(ContainerAsset(container_id=c.id, asset_id=a.id))
    db.add(_rule("Pack location", status="rfid_4_into_cage", actions=(
        ("set_asset_location_from_container", {}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    assert a.location_detail == "crate-7"


async def test_asset_context_without_container_skips(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Pack location", status="rfid_4_into_cage", actions=(
        ("set_asset_location_from_container", {}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.actions_applied == [
        {"action_type": "set_asset_location_from_container",
         "applied": False, "reason": "not_in_container"}]
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_engine.py -v -k container`
Expected: first test FAILS (`location_detail` unchanged — no container in context).

- [ ] **Step 3: Implement.** In `engine.py`'s `_build_context`, inside the `match_type == "asset"` branch (after `ctx.asset = ...`, before the initiative pair query), add:

```python
        # For asset matches ctx.container is the CONTAINING container
        # (container_assets.asset_id is unique); for container matches
        # it stays the matched container.
        ctx.container = await db.scalar(
            select(Container)
            .join(ContainerAsset,
                  ContainerAsset.container_id == Container.id)
            .where(ContainerAsset.asset_id == scan.asset_id))
```

Add `ContainerAsset` to the engine's models import. Update the `Context` docstring in `context.py` with one line noting the dual meaning of `container`.

- [ ] **Step 4: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_engine.py api/tests/test_scan_worker.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules/engine.py api/src/serversherpa/status_rules/context.py api/tests/test_status_rules_engine.py
git commit -m "feat(api): engine context resolves an asset's containing container"
```

---

### Task 3: Importer module — parse, translate, upsert

**Files:**
- Create: `api/src/serversherpa/status_rules/v2_import.py`
- Test: `api/tests/test_status_rules_v2_import.py`

**Interfaces:**
- Consumes: `insert_rows(dump_path, table)` from `serversherpa.sites.v2_import` (streams `[values]` lists per INSERT row); Task 1's action keys; models `StatusRule`/`StatusRuleCondition`/`StatusRuleAction`/`StatusValue`.
- Produces (consumed by Task 4's CLI): `async def import_rules(db: AsyncSession, dump_path: str) -> dict` returning `{"imported": int, "updated": int, "partial": [(rule_name, dropped_desc, reason)], "skipped": [(rule_name, reason)]}`. Adds/updates rows in the session; never commits.

- [ ] **Step 1: Write the failing tests.** The fixture embeds real INSERT lines from the backup (values abridged only where noted). Write to `api/tests/test_status_rules_v2_import.py`:

```python
"""V2 process-engine rule import: translation, skip/partial reporting,
idempotent upsert, enabled preservation, and an end-to-end run through
the worker. Fixture rows are verbatim from backup_20260825_193157.sql
(timestamps shortened)."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRule,
)
from serversherpa.scans import worker
from serversherpa.status_rules.engine import invalidate_cache
from serversherpa.status_rules.v2_import import import_rules

FIXTURE = """
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (9, 'RFID 1 - Cage Exit', 'Assets', 9, 9, '#31F527', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (19, 'RFID 4 - Into Cage', 'Assets', 19, 19, '#f5297a', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (13, 'In Container', 'Assets', 13, 13, '#888888', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (45, 'In-Transit', 'Trucks', 45, 45, '#111111', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (16, 'RFID 1 - Exiting Cage', 'Asset detected leaving the cage via RFID reader.', 'moves_assets_list', 9, 9, TRUE, '2026-01-03T06:36:04+00:00', '2026-01-14T20:23:29+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (23, 'Scan Type 19: RFID 4 - In Cage', 'Asset detected entering destination cage via RFID.', 'moves_assets_list', 19, 19, TRUE, '2026-01-03T06:36:05+00:00', '2026-01-14T21:00:50+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (29, 'Asset Packed In Container', '', 'moves_assets_list', 13, 10, TRUE, '2026-01-21T04:18:22+00:00', '2026-01-29T21:24:34+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (27, 'Truck Left Source - In Transit', 'GPS.', 'trucks', 45, 100, TRUE, '2026-01-03T06:36:05+00:00', '2026-01-03T06:36:05+00:00', NULL);
INSERT INTO process_engine_conditions (id, rule_id, condition_table, field_name, operator, value, logic, value_min, value_max) VALUES (4, 27, 'trucks', 'start_site', 'is_not_null', '', 'AND', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (135, 16, 1, 'set_status', 'moves_assets_list', 'asset_status', NULL, '9', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (136, 16, 2, 'set_status', 'assets', 'status', NULL, '9', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (137, 16, 3, 'clear_field', 'assets', 'location', NULL, NULL, NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (141, 23, 1, 'set_status', 'moves_assets_list', 'asset_status', NULL, '19', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (142, 23, 2, 'copy_field', 'assets', 'location', 'field_reference', 'trigger.scan_location', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (143, 23, 3, 'set_status', 'assets', 'status', 'static', '19', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (150, 29, 1, 'set_field', 'assets', 'location', 'field_reference', 'container.container_name', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (151, 29, 2, 'clear_field', 'assets', 'site', NULL, NULL, NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (152, 29, 3, 'set_status', 'assets', 'status', 'static', '13', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (160, 29, 4, 'set_field', 'assets', 'weird_field', 'static', 'x', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (87, 27, 1, 'set_status', 'trucks', 'truck_status', NULL, '45', NULL, NULL);
"""


def _dump(tmp_path):
    p = tmp_path / "v2.sql"
    p.write_text(FIXTURE)
    return str(p)


async def test_import_translates_and_reports(db, tmp_path):
    stats = await import_rules(db, _dump(tmp_path))
    await db.commit()

    assert stats["imported"] == 3
    assert stats["updated"] == 0
    assert [name for name, _ in stats["skipped"]] == [
        "Truck Left Source - In Transit"]
    assert len(stats["partial"]) == 1          # rule 29's weird_field action
    assert stats["partial"][0][0] == "Asset Packed In Container"

    rules = {r.name: r for r in (await db.scalars(
        select(StatusRule))).all()}
    cage = rules["RFID 1 - Exiting Cage"]
    assert cage.trigger_status == "rfid_1_cage_exit"
    assert cage.trigger_match_type == "asset"
    assert cage.priority == 9
    assert cage.enabled is False
    assert [(a.action_type, a.params) for a in cage.actions] == [
        ("set_initiative_asset_status", {"status": "rfid_1_cage_exit"}),
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),
        ("clear_asset_location", {}),
    ]
    incage = rules["Scan Type 19: RFID 4 - In Cage"]
    assert [(a.action_type, a.params) for a in incage.actions] == [
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),
        ("set_asset_location_from_scan", {"fields": "location"}),
        ("set_asset_status", {"status": "rfid_4_into_cage"}),
    ]
    packed = rules["Asset Packed In Container"]
    assert [(a.action_type, a.params) for a in packed.actions] == [
        ("set_asset_location_from_container", {}),
        ("clear_asset_site", {}),
        ("set_asset_status", {"status": "in_container"}),
    ]


async def test_reimport_is_idempotent_and_preserves_enabled(db, tmp_path):
    path = _dump(tmp_path)
    await import_rules(db, path)
    await db.commit()
    rule = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    rule.enabled = True
    rule.priority = 99                          # local drift, gets re-imported
    await db.commit()

    stats = await import_rules(db, path)
    await db.commit()
    assert stats["imported"] == 0
    assert stats["updated"] == 3

    again = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    assert again.enabled is True                # preserved
    assert again.priority == 9                  # V2 value restored
    assert len(again.actions) == 3              # children replaced, not doubled


async def test_end_to_end_imported_rule_fires(db, tmp_path):
    invalidate_cache()
    await import_rules(db, _dump(tmp_path))
    rule = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    rule.enabled = True
    a = Asset(serial_number="SN-E2E", status="racked",
              location_detail="R4 RU10")
    scan = RawScan(scanned_value="SN-E2E", scan_type="rfid",
                   status="rfid_1_cage_exit", scanned_at=datetime.now(UTC))
    db.add_all([a, scan])
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "matched"
    async with get_sessionmaker()() as check:
        seen = await check.get(Asset, a.id)
        assert seen.status == "rfid_1_cage_exit"
        assert seen.location_detail == ""       # clear_asset_location fired
    invalidate_cache()
```

Note the fixture's synthetic action id 160 (`weird_field`) — added deliberately to exercise the partial path; everything else is verbatim backup data.

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_v2_import.py -v`
Expected: FAIL — `ModuleNotFoundError: serversherpa.status_rules.v2_import`

- [ ] **Step 3: Implement**

```python
# api/src/serversherpa/status_rules/v2_import.py
"""Import V2 process-engine rules from a legacy BaseCamp V2 pg_dump as
V3 status rules. One-shot seeding helper behind
`serversherpa import-v2-status-rules` — like people/v2_import.py, and
reusing the sites importer's INSERT-statement row streaming.

Only rules with trigger_table='moves_assets_list' are importable — the
others reference trucks, which V3 does not have. Upsert is by rule
name: first inserts land DISABLED for review in /admin/status-rules;
re-runs update fields and replace children but preserve the rule's
current enabled flag. Data wins over prose: action values import as
stored even where a V2 description says otherwise."""

from typing import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    StatusRule, StatusRuleAction, StatusRuleCondition, StatusValue,
)
from serversherpa.sites.v2_import import insert_rows

RULE_COLS = ("id", "name", "description", "trigger_table",
             "trigger_status_id", "priority", "enabled", "created_at",
             "updated_at", "created_by")
COND_COLS = ("id", "rule_id", "condition_table", "field_name", "operator",
             "value", "logic", "value_min", "value_max")
ACTION_COLS = ("id", "rule_id", "action_order", "action_type",
               "target_table", "target_field", "value_source", "value",
               "expression_type", "expression_inputs")

# V2 status_options.status_name -> V3 asset-vocab key. Lookup is by the
# dump's unique id first, so duplicate names on non-asset ids can't
# collide. Verified against live status_values at import time.
V2_NAME_TO_V3_KEY = {
    "Loaded In System": "loaded_in_system",
    "Pre-Stage": "pre_stage",
    "Racked": "racked",
    "RFID 1 - Cage Exit": "rfid_1_cage_exit",
    "Labeled": "labeled",
    "RFID 2 - Loading Dock": "rfid_2_loading_dock",
    "Pack / Logistics": "pack_logistics",
    "In Container": "in_container",
    "On Truck": "on_truck",
    "Received": "received",
    "Un-Pack": "un_pack",
    "RFID 3 - Staging": "rfid_3_staging",
    "Staged": "staged",
    "RFID 4 - Into Cage": "rfid_4_into_cage",
    "Re-Racked": "re_racked",
    "Cabling": "cabling",
    "QA": "qa",
    "Complete": "complete",
    "In Transit": "in_transit",
    "e-waste": "e_waste",
    "Historical": "historical",
    "Pending Client Handover": "pending_client_handover",
}


def _rows(dump_path: str, table: str, cols: tuple) -> Iterator[dict]:
    for values in insert_rows(dump_path, table):
        if len(values) == len(cols):
            yield dict(zip(cols, values))


def _status_key(v2_id, id_to_name: dict) -> str | None:
    name = id_to_name.get(int(v2_id)) if v2_id is not None else None
    return V2_NAME_TO_V3_KEY.get(name) if name else None


def translate_action(row: dict, id_to_name: dict):
    """(v3 {action_type, params}, None) on success, (None, reason) on drop."""
    atype = row["action_type"]
    table, field = row["target_table"], row["target_field"]
    value = row["value"]
    where = f"{atype} {table}.{field}"

    if atype == "set_status" and table == "moves_assets_list" \
            and field == "asset_status":
        key = _status_key(value, id_to_name)
        if key is None:
            return None, f"{where}: unknown status id {value}"
        return {"action_type": "set_initiative_asset_status",
                "params": {"status": key}}, None
    if atype == "set_status" and table == "assets" and field == "status":
        key = _status_key(value, id_to_name)
        if key is None:
            return None, f"{where}: unknown status id {value}"
        return {"action_type": "set_asset_status",
                "params": {"status": key}}, None
    if atype == "set_field" and table == "moves_assets_list" \
            and field in ("source_verified", "destination_verified") \
            and str(value).lower() == "true":
        return {"action_type": "set_initiative_asset_verified",
                "params": {"side": field.removesuffix("_verified"),
                           "value": True}}, None
    if atype == "copy_field" and table == "assets" and field == "site" \
            and value == "trigger.scan_site":
        return {"action_type": "set_asset_location_from_scan",
                "params": {"fields": "site"}}, None
    if atype == "copy_field" and table == "assets" and field == "location" \
            and value == "trigger.scan_location":
        return {"action_type": "set_asset_location_from_scan",
                "params": {"fields": "location"}}, None
    inputs = str(row.get("expression_inputs") or "")
    if table == "assets" and field == "location" and (
            (atype == "expression"
             and row.get("expression_type") == "concat_if_exists")
            or (atype == "set_field" and row.get("value_source") == "template")):
        if "destination_" in inputs:
            return {"action_type": "set_asset_location_from_initiative",
                    "params": {"side": "destination"}}, None
        if "source_" in inputs:
            return {"action_type": "set_asset_location_from_initiative",
                    "params": {"side": "source"}}, None
        return None, f"{where}: expression references neither side"
    if atype == "clear_field" and table == "assets" and field == "location":
        return {"action_type": "clear_asset_location", "params": {}}, None
    if atype == "clear_field" and table == "assets" and field == "site":
        return {"action_type": "clear_asset_site", "params": {}}, None
    if atype == "set_field" and table == "assets" and field == "location" \
            and row.get("value_source") == "field_reference" \
            and value == "container.container_name":
        return {"action_type": "set_asset_location_from_container",
                "params": {}}, None
    return None, f"{where}: no V3 equivalent"


async def import_rules(db: AsyncSession, dump_path: str) -> dict:
    id_to_name = {int(r["id"]): r["status_name"]
                  for r in _rows(dump_path, "status_options",
                                 ("id", "status_name", "association_type",
                                  "sort_order", "process_order", "color",
                                  "metadata", "created_at", "updated_at",
                                  "list_in_dropdown", "process_type",
                                  "description"))}
    vocab = set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "asset"))).all())

    conditions: dict[int, list[dict]] = {}
    for c in _rows(dump_path, "process_engine_conditions", COND_COLS):
        conditions.setdefault(int(c["rule_id"]), []).append(c)
    actions: dict[int, list[dict]] = {}
    for a in _rows(dump_path, "process_engine_actions", ACTION_COLS):
        actions.setdefault(int(a["rule_id"]), []).append(a)

    stats = {"imported": 0, "updated": 0, "partial": [], "skipped": []}
    rules = sorted(_rows(dump_path, "process_engine_rules", RULE_COLS),
                   key=lambda r: (int(r["priority"]), int(r["id"])))
    for rule in rules:
        name = rule["name"]
        if rule["trigger_table"] != "moves_assets_list":
            stats["skipped"].append(
                (name, f"trigger table '{rule['trigger_table']}' has no "
                       "V3 equivalent (no trucks)"))
            continue
        trigger_key = _status_key(rule["trigger_status_id"], id_to_name)
        if trigger_key is None or trigger_key not in vocab:
            stats["skipped"].append(
                (name, f"trigger status id {rule['trigger_status_id']} "
                       "not in the V3 asset vocabulary"))
            continue
        # scan_match_category conditions are absorbed by V3's trigger
        # match type; any other condition means the rule would over-fire
        # without its gate — skip it.
        blocked = [c for c in conditions.get(int(rule["id"]), [])
                   if not (c["condition_table"] == "scans_processed"
                           and c["field_name"] == "scan_match_category")]
        if blocked:
            stats["skipped"].append(
                (name, f"unmapped condition on "
                       f"{blocked[0]['condition_table']}."
                       f"{blocked[0]['field_name']}"))
            continue

        translated, dropped = [], []
        for a in sorted(actions.get(int(rule["id"]), []),
                        key=lambda a: int(a["action_order"])):
            payload, reason = translate_action(a, id_to_name)
            if payload is None:
                dropped.append(reason)
            else:
                translated.append(payload)
        if not translated:
            stats["skipped"].append((name, "no translatable actions"))
            continue
        for reason in dropped:
            stats["partial"].append((name, reason, "action dropped"))

        children = [StatusRuleAction(position=i, **{
            "action_type": p["action_type"], "params": p["params"]})
            for i, p in enumerate(translated, 1)]
        existing = await db.scalar(
            select(StatusRule)
            .options(selectinload(StatusRule.conditions),
                     selectinload(StatusRule.actions))
            .where(StatusRule.name == name))
        if existing is None:
            db.add(StatusRule(
                name=name, description=rule["description"] or "",
                trigger_status=trigger_key, trigger_match_type="asset",
                priority=int(rule["priority"]), enabled=False,
                conditions=[], actions=children))
            stats["imported"] += 1
        else:
            existing.description = rule["description"] or ""
            existing.trigger_status = trigger_key
            existing.trigger_match_type = "asset"
            existing.priority = int(rule["priority"])
            existing.conditions[:] = []
            existing.actions[:] = children          # enabled untouched
            stats["updated"] += 1
    await db.flush()
    return stats
```

Check `insert_rows`'s value parsing while implementing: `parse_values_tuple` in `sites/v2_import.py` — confirm how it renders SQL `TRUE`/`NULL` (Python bool/None or strings) and adjust the `int(...)`/truthiness call sites in this module accordingly. The tests pin the observable behavior either way.

- [ ] **Step 4: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_v2_import.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules/v2_import.py api/tests/test_status_rules_v2_import.py
git commit -m "feat(api): V2 process-engine rule importer — translate + upsert"
```

---

### Task 4: CLI command `import-v2-status-rules`

**Files:**
- Modify: `api/src/serversherpa/cli.py` (after the other `import_v2_*` commands)
- Test: `api/tests/test_cli_status_rules_import.py`

**Interfaces:**
- Consumes: Task 3's `import_rules(db, dump) -> dict`.
- Produces: `serversherpa import-v2-status-rules --dump <path> [--dry-run]`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_cli_status_rules_import.py
"""CLI surface of `serversherpa import-v2-status-rules` — help text and
dry-run report shape; the importer's behavior is covered in
test_status_rules_v2_import.py."""

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_dump_and_dry_run():
    result = runner.invoke(app, ["import-v2-status-rules", "--help"])
    assert result.exit_code == 0
    assert "--dump" in result.output
    assert "--dry-run" in result.output


def test_missing_dump_errors():
    result = runner.invoke(app, ["import-v2-status-rules"])
    assert result.exit_code != 0
```

- [ ] **Step 2: Run to verify failure**

Run: `api/.venv/bin/pytest api/tests/test_cli_status_rules_import.py -v`
Expected: FAIL — exit code 2 (unknown command)

- [ ] **Step 3: Implement.** Append to `cli.py` near the other importers (match `import_v2_workers`'s shape):

```python
@app.command()
def import_v2_status_rules(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Import V2 process-engine rules as V3 status rules. Upserts by
    rule name; first imports land DISABLED for review in
    /admin/status-rules. Truck-dependent rules are skipped (no trucks
    in V3)."""

    async def _run() -> None:
        from serversherpa.status_rules.v2_import import import_rules

        async with get_sessionmaker()() as db:
            stats = await import_rules(db, dump)
            for name, reason in stats["skipped"]:
                typer.secho(f"skipped: {name} — {reason}", fg="yellow")
            for name, what, _ in stats["partial"]:
                typer.secho(f"partial: {name} — {what}", fg="yellow")
            summary = (f"{stats['imported']} imported (disabled), "
                       f"{stats['updated']} updated, "
                       f"{len(stats['partial'])} partial, "
                       f"{len(stats['skipped'])} skipped")
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] {summary}", fg="yellow")
            else:
                await db.commit()
                typer.secho(summary, fg="green")
        await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 4: Run to verify pass**

Run: `api/.venv/bin/pytest api/tests/test_cli_status_rules_import.py api/tests/test_status_rules_v2_import.py -v`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/cli.py api/tests/test_cli_status_rules_import.py
git commit -m "feat(api): import-v2-status-rules CLI command"
```

---

### Task 5: Verification — suites + real-backup import on the dev DB

**Files:** none (fix regressions in place if any surface).

- [ ] **Step 1: Full API suite** — FOREGROUND, timeout 600000ms:

Run: `api/.venv/bin/pytest api/tests -x -q`
Expected: all pass (~890).

- [ ] **Step 2: Dry-run against the real backup**

Run: `api/.venv/bin/serversherpa import-v2-status-rules --dump api/backups/backup_20260825_193157.sql --dry-run`
Expected: exit 0; report shows **13 imported (disabled), 0 updated, 3 skipped** and zero (or explained) partials. The three skipped lines name the two truck rules and "Scan Type 48: Container Assigned to Truck". Any other skip/partial means a mapping gap — investigate before proceeding.

- [ ] **Step 3: Real import**

Run: `api/.venv/bin/serversherpa import-v2-status-rules --dump api/backups/backup_20260825_193157.sql`
Expected: same counts, green summary. Then verify via SQL:

Run: `docker exec serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa -Atc "SELECT count(*), bool_or(enabled) FROM status_rules WHERE created_by IS NULL"`
Expected: count ≥ 13 and `bool_or` reflects only pre-existing enabled rules (freshly imported ones are all disabled).

- [ ] **Step 4: Re-run to prove idempotence**

Run: `api/.venv/bin/serversherpa import-v2-status-rules --dump api/backups/backup_20260825_193157.sql`
Expected: **0 imported, 13 updated**, same skips; rule count in the DB unchanged.

- [ ] **Step 5: Clean tree + final commit if anything moved**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git status
```

Expected: clean.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** §1 catalog → Tasks 1–2; §2 importer (parsing, translation table, skips, conditions, upsert/enabled semantics, report, single transaction) → Tasks 3–4; §3 testing (catalog, engine, importer unit, e2e, manual real-backup run) → Tasks 1–5. Out-of-scope items untouched.
- **Placeholders:** none; every code step is complete. The one deliberate open verification (how `parse_values_tuple` renders TRUE/NULL) is flagged as an implementation check with tests pinning observable behavior.
- **Type consistency:** `import_rules(db, dump_path) -> dict` (T3→T4); action keys `clear_asset_location`/`clear_asset_site`/`set_asset_location_from_container`/`set_asset_location_from_scan{fields}` (T1→T3 translator and tests); `ctx.container` containment (T2→T1's container action test uses an explicit Context, T3's e2e goes through the engine).
