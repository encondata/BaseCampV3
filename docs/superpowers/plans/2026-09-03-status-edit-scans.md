# Status Edits → Processed Scans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every API status change on an initiative asset inserts a `processed_scans` row (scan type `manual`, operator = the editor) and runs the status-rules engine synchronously in the same transaction, anchored to the edited initiative — per docs/superpowers/specs/2026-09-03-status-edit-scans-design.md.

**Architecture:** A one-function service (`scans/manual.py::record_status_edit`) builds the scan and calls the engine; `status_rules/engine.py` gains an optional explicit `initiative_asset` for context; `update_initiative_asset` calls the service when `status` actually changed and maps `RuleExecutionError` → 409 `rule_failed` with rollback. No migration.

**Tech Stack:** FastAPI + SQLAlchemy async; React + vitest (jsdom) for the one dialog test.

## Global Constraints

- Scan row values (verbatim): `scanned_value` = `asset.serial_number` or `str(asset.id)` when blank/None; `scan_type = "manual"`; `status` = the NEW status; `scanned_at == processed_at` = `datetime.now(UTC)`; `device_id = "portal"`; `operator_id` = actor person id; `site_id = None`; `location_detail = ""`; `source = "initiative_asset_edit"`; `raw_scan_id = None`; `match_type = "asset"`; `asset_id`. `Asset.last_seen_at` is NOT touched.
- Record only when `status` actually changed (present in the audit `changes`); same-value and other-field edits record nothing.
- Rule failure → HTTP 409 `{"detail": {"code": "rule_failed", "rule_name": ..., "reason": ...}}`; transaction rolled back — no status change, no scan, no audit row.
- Engine: `apply_rules(db, scan, *, initiative_asset=None)`; worker callers unchanged.
- Portal copy: `Rule '<rule_name>' failed: <reason>`.
- API tests: from `api/`, `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest …` (the shared `serversherpa_test` DB is stamped at a migration this branch doesn't have). Portal: from `portal/`, `npx vitest run …`. Always FOREGROUND, one continuous call, timeout 600000ms — never background.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Engine — explicit initiative context

**Files:**
- Modify: `api/src/serversherpa/status_rules/engine.py` (`_build_context` ~line 67, `apply_rules` ~line 99)
- Test: `api/tests/test_status_rules_engine.py` (append)

**Interfaces:**
- Produces: `apply_rules(db, scan, *, initiative_asset: InitiativeAsset | None = None) -> int`; `_build_context(db, scan, *, initiative_asset=None)`. When given, `ctx.initiative_asset = initiative_asset` and `ctx.initiative = await db.get(Initiative, initiative_asset.initiative_id)`; the in-progress lookup is skipped. Task 2 consumes this.

- [ ] **Step 1: Write the failing test** — append to `api/tests/test_status_rules_engine.py` (it already imports `Asset`, `ProcessedScan`, `StatusRule*`, `apply_rules`, `_rule`, `_asset_scan`; add `Initiative`, `InitiativeAsset` to the models import if missing, and `from serversherpa.status_rules.engine import _build_context`):

```python
async def test_explicit_initiative_asset_overrides_in_progress_lookup(db):
    a = Asset(status="unknown")
    live = Initiative(name="Live", initiative_type="move", status="in_progress")
    planned = Initiative(name="Planned", initiative_type="move", status="planned")
    db.add_all([a, live, planned])
    await db.flush()
    on_live = InitiativeAsset(initiative_id=live.id, asset_id=a.id,
                              status="loaded_in_system")
    on_planned = InitiativeAsset(initiative_id=planned.id, asset_id=a.id,
                                 status="loaded_in_system")
    db.add_all([on_live, on_planned])
    await db.flush()
    scan = await _asset_scan(db, a)

    # default: the engine picks the in-progress initiative
    ctx = await _build_context(db, scan)
    assert ctx.initiative.id == live.id
    assert ctx.initiative_asset.id == on_live.id

    # explicit: the caller's row wins, even though it isn't in progress
    ctx = await _build_context(db, scan, initiative_asset=on_planned)
    assert ctx.initiative.id == planned.id
    assert ctx.initiative_asset.id == on_planned.id


async def test_apply_rules_acts_on_the_explicit_initiative_asset(db):
    a = Asset(status="unknown")
    live = Initiative(name="Live", initiative_type="move", status="in_progress")
    planned = Initiative(name="Planned", initiative_type="move", status="planned")
    db.add_all([a, live, planned])
    await db.flush()
    on_live = InitiativeAsset(initiative_id=live.id, asset_id=a.id,
                              status="loaded_in_system")
    on_planned = InitiativeAsset(initiative_id=planned.id, asset_id=a.id,
                                 status="loaded_in_system")
    db.add_all([on_live, on_planned])
    db.add(_rule("Mark move row", actions=(
        ("set_initiative_asset_status", {"status": "in_transit"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)

    n = await apply_rules(db, scan, initiative_asset=on_planned)
    await db.commit()
    assert n == 1
    assert on_planned.status == "in_transit"
    assert on_live.status == "loaded_in_system"      # untouched
```

(If `Initiative(...)` needs more required columns in this codebase, copy the minimal constructor used by `api/tests/test_initiatives_model.py`.)

- [ ] **Step 2: Run to verify failure** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_status_rules_engine.py -q -k explicit` → TypeError (unexpected kwarg).

- [ ] **Step 3: Implement** — in `engine.py`:

```python
async def _build_context(db: AsyncSession, scan: ProcessedScan, *,
                         initiative_asset: InitiativeAsset | None = None) -> Context:
    ctx = Context(scan=scan)
    if scan.match_type == "asset":
        ctx.asset = await db.get(Asset, scan.asset_id)
        ctx.container = await db.scalar(
            select(Container)
            .join(ContainerAsset,
                  ContainerAsset.container_id == Container.id)
            .where(ContainerAsset.asset_id == scan.asset_id))
        if initiative_asset is not None:
            # A manual edit is anchored to the initiative being edited —
            # never re-resolved to "the in-progress one".
            ctx.initiative_asset = initiative_asset
            ctx.initiative = await db.get(Initiative, initiative_asset.initiative_id)
        else:
            pair = (await db.execute(
                ...existing in-progress query unchanged...
            )).first()
            if pair is not None:
                ctx.initiative_asset, ctx.initiative = pair
    elif ...unchanged...
    return ctx


async def apply_rules(db: AsyncSession, scan: ProcessedScan, *,
                      initiative_asset: InitiativeAsset | None = None) -> int:
    if scan.status is None:
        return 0
    rules = await _load_rules(db, scan.status, scan.match_type)
    if not rules:
        return 0
    ctx = await _build_context(db, scan, initiative_asset=initiative_asset)
    ...rest unchanged...
```

Update the module/function docstrings to mention the explicit anchor.

- [ ] **Step 4: Run** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_status_rules_engine.py tests/test_scans_worker.py -q` (use whichever worker test file exists — `ls tests | grep -i worker`) → all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules/engine.py api/tests/test_status_rules_engine.py
git commit -m "feat(rules): apply_rules accepts an explicit initiative_asset anchor"
```

---

### Task 2: `scans/manual.py` — record a manual status edit

**Files:**
- Create: `api/src/serversherpa/scans/manual.py`
- Test: `api/tests/test_scans_manual.py` (new)

**Interfaces:**
- Consumes: `apply_rules(db, scan, initiative_asset=...)` (Task 1).
- Produces: `record_status_edit(db, *, assoc: InitiativeAsset, asset: Asset, status: str, actor_person_id: uuid.UUID) -> ProcessedScan` (adds + flushes, never commits; propagates `RuleExecutionError`). Constants `SOURCE_INITIATIVE_ASSET_EDIT = "initiative_asset_edit"`, `PORTAL_DEVICE_ID = "portal"`. Task 3 consumes these.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_scans_manual.py`:

```python
"""Manual status edits recorded as processed scans (spec 2026-09-03)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Initiative, InitiativeAsset, Person, ProcessedScan,
    StatusRuleExecution,
)
from serversherpa.scans.manual import (
    PORTAL_DEVICE_ID, SOURCE_INITIATIVE_ASSET_EDIT, record_status_edit,
)
from serversherpa.status_rules.engine import RuleExecutionError, invalidate_cache

from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


async def _setup(db, *, serial="SN-42", asset_status="active"):
    editor = Person(first_name="Eddie", last_name="Editor")
    asset = Asset(serial_number=serial, name="srv-1", status=asset_status)
    move = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([editor, asset, move])
    await db.flush()
    assoc = InitiativeAsset(initiative_id=move.id, asset_id=asset.id,
                            status="in_transit")
    db.add(assoc)
    await db.flush()
    return editor, asset, move, assoc


async def test_records_a_manual_scan_with_the_editor(db):
    editor, asset, _move, assoc = await _setup(db)
    before = datetime.now(UTC)
    scan = await record_status_edit(db, assoc=assoc, asset=asset,
                                    status="in_transit",
                                    actor_person_id=editor.id)
    await db.commit()

    row = (await db.scalars(select(ProcessedScan))).one()
    assert row.id == scan.id
    assert row.scanned_value == "SN-42"
    assert row.scan_type == "manual"
    assert row.status == "in_transit"
    assert row.scanned_at == row.processed_at >= before
    assert row.device_id == PORTAL_DEVICE_ID == "portal"
    assert row.operator_id == editor.id
    assert row.site_id is None and row.location_detail == ""
    assert row.source == SOURCE_INITIATIVE_ASSET_EDIT == "initiative_asset_edit"
    assert row.raw_scan_id is None
    assert row.match_type == "asset" and row.asset_id == asset.id
    assert asset.last_seen_at is None            # not a presence read


async def test_falls_back_to_the_asset_id_without_a_serial(db):
    editor, asset, _move, assoc = await _setup(db, serial=None)
    await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                             actor_person_id=editor.id)
    await db.commit()
    row = (await db.scalars(select(ProcessedScan))).one()
    assert row.scanned_value == str(asset.id)


async def test_runs_rules_against_the_edited_initiative(db):
    editor, asset, _move, assoc = await _setup(db)
    db.add(_rule("Stage it", status="in_transit", actions=(
        ("set_asset_status", {"status": "in_storage"}),
        ("set_initiative_asset_status", {"status": "loaded_in_system"}),)))
    await db.flush()
    await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                             actor_person_id=editor.id)
    await db.commit()
    assert asset.status == "in_storage"
    assert assoc.status == "loaded_in_system"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True and ex.error is None


async def test_rule_failure_propagates(db):
    editor, asset, _move, assoc = await _setup(db)
    db.add(_rule("Broken", status="in_transit", actions=(
        ("set_asset_status", {"status": "no-such-status"}),)))
    await db.flush()
    with pytest.raises(RuleExecutionError) as exc:
        await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                                 actor_person_id=editor.id)
    assert exc.value.rule_name == "Broken"
```

- [ ] **Step 2: Run to verify failure** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_scans_manual.py -q` → ModuleNotFoundError.

- [ ] **Step 3: Implement** — `api/src/serversherpa/scans/manual.py`:

```python
"""Manual status edits recorded as processed scans. A user changing an
initiative asset's status in the portal is, for history and for the
status-rules engine, the same event as a scanner reporting that status —
so it gets a processed_scans row (scan_type "manual", operator = the
editor) and the rules run right here, in the caller's transaction,
anchored to the initiative being edited. Not a presence read: no site,
no location, and Asset.last_seen_at is left alone."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, InitiativeAsset, ProcessedScan
from serversherpa.status_rules.engine import apply_rules

SOURCE_INITIATIVE_ASSET_EDIT = "initiative_asset_edit"
PORTAL_DEVICE_ID = "portal"


async def record_status_edit(
    db: AsyncSession, *, assoc: InitiativeAsset, asset: Asset, status: str,
    actor_person_id: uuid.UUID,
) -> ProcessedScan:
    """Add (flush, don't commit) the scan and apply rules for it.
    Raises RuleExecutionError when a rule action fails — the caller owns
    the transaction and decides to roll back."""
    now = datetime.now(UTC)
    scan = ProcessedScan(
        scanned_value=asset.serial_number or str(asset.id),
        scan_type="manual", status=status,
        scanned_at=now, processed_at=now,
        device_id=PORTAL_DEVICE_ID, operator_id=actor_person_id,
        site_id=None, location_detail="",
        source=SOURCE_INITIATIVE_ASSET_EDIT, raw_scan_id=None,
        match_type="asset", asset_id=asset.id,
    )
    db.add(scan)
    await db.flush()
    await apply_rules(db, scan, initiative_asset=assoc)
    return scan
```

- [ ] **Step 4: Run** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_scans_manual.py -q` → 4 pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/scans/manual.py api/tests/test_scans_manual.py
git commit -m "feat(scans): record_status_edit — manual processed scan + rules for a status edit"
```

---

### Task 3: Route wiring — PATCH records the scan, 409 on rule failure

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`update_initiative_asset` ~line 775; imports ~line 27)
- Test: `api/tests/test_initiative_status_scans_api.py` (new)

**Interfaces:**
- Consumes: `record_status_edit`, `SOURCE_INITIATIVE_ASSET_EDIT` (Task 2); `RuleExecutionError` from `serversherpa.status_rules.engine`.
- Produces: 409 `rule_failed` `{code, rule_name, reason}` contract for the portal (Task 4).

- [ ] **Step 1: Write the failing tests** — `api/tests/test_initiative_status_scans_api.py`:

```python
"""PATCH /initiatives/assets/{id}: status changes become manual processed
scans and run the rules engine in the request."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AuditLog, InitiativeAsset, ProcessedScan, StatusRuleExecution,
)
from serversherpa.status_rules.engine import invalidate_cache

from tests.test_assets_api import login
from tests.test_initiative_assets_api import _asset, _move
from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


async def _attached(client, db, hdrs, **asset_kw):
    iid = await _move(client, hdrs)
    asset = await _asset(db, serial_number="SN-9", name="srv-9",
                         status="active", **asset_kw)
    await db.commit()
    resp = await client.post(f"/initiatives/{iid}/assets", headers=hdrs,
                             json={"asset_ids": [str(asset.id)]})
    assert resp.status_code == 201, resp.text
    row = resp.json()[0]
    return iid, asset, row


async def test_status_change_records_a_manual_scan(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "in_transit"

    scan = (await db.scalars(select(ProcessedScan))).one()
    assert scan.scan_type == "manual"
    assert scan.status == "in_transit"
    assert scan.asset_id == asset.id
    assert scan.operator_id == seeded_user.id
    assert scan.device_id == "portal"
    assert scan.source == "initiative_asset_edit"
    assert scan.site_id is None and scan.raw_scan_id is None
    assert scan.scanned_value == "SN-9"


async def test_no_scan_for_same_status_or_other_fields(client, db, seeded_user):
    hdrs = await login(client)
    _iid, _asset, row = await _attached(client, db, hdrs)
    current = row["status"]
    for body in ({"status": current}, {"owner": "Ops"}, {"source_rack": "R1"}):
        resp = await client.patch(f"/initiatives/assets/{row['id']}",
                                  headers=hdrs, json=body)
        assert resp.status_code == 200, resp.text
    assert (await db.scalars(select(ProcessedScan))).all() == []


async def test_rules_fire_in_the_request_against_this_initiative(client, db, seeded_user):
    hdrs = await login(client)
    iid, asset, row = await _attached(client, db, hdrs)
    db.add(_rule("Stage", status="in_transit", actions=(
        ("set_asset_status", {"status": "in_storage"}),)))
    await db.commit()

    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    # response already reflects the rule's side-effect on the asset
    assert resp.json()["asset"]["status"] == "in_storage"
    await db.refresh(asset)
    assert asset.status == "in_storage"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True
    scan = (await db.scalars(select(ProcessedScan))).one()
    assert ex.processed_scan_id == scan.id


async def test_rule_failure_blocks_the_edit(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    db.add(_rule("Broken", status="in_transit", actions=(
        ("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()

    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "rule_failed"
    assert detail["rule_name"] == "Broken"
    assert detail["reason"]

    # nothing persisted: status, scan, audit
    assoc = await db.get(InitiativeAsset, row["id"])
    await db.refresh(assoc)
    assert assoc.status == row["status"]
    assert (await db.scalars(select(ProcessedScan))).all() == []
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "asset_update"))).all()
    assert audits == []


async def test_provenance_reports_the_manual_scan(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200
    resp = await client.get("/status/provenance", headers=hdrs, params={
        "entity_type": "asset", "entity_id": str(asset.id),
        "status": "in_transit"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "scan"
    assert body["scan_type"] == "manual"
    assert body["device_id"] == "portal"
```

(The provenance endpoint's exact param names live in `tests/test_status_provenance.py::_get` — match them.)

- [ ] **Step 2: Run to verify failure** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_initiative_status_scans_api.py -q` → scan-count assertions fail.

- [ ] **Step 3: Implement** — `routes/initiatives.py`: add imports `from serversherpa.scans.manual import record_status_edit` and `from serversherpa.status_rules.engine import RuleExecutionError`; in `update_initiative_asset`, replace the tail from `changes = diff(...)` to `await db.commit()` with:

```python
    changes = diff(before, snapshot(assoc, fields))
    if changes:
        assoc.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(assoc.initiative_id), action="asset_update",
              changes=changes)
    if "status" in changes:
        # A status edit is a scan event: record it and run the rules
        # engine here, anchored to THIS initiative. A failing rule rolls
        # the whole edit back — history and dependent fields never drift.
        asset = await db.get(Asset, assoc.asset_id)
        try:
            await record_status_edit(db, assoc=assoc, asset=asset,
                                     status=assoc.status,
                                     actor_person_id=actor.person.id)
        except RuleExecutionError as err:
            await db.rollback()
            raise _err(409, "rule_failed", rule_name=err.rule_name,
                       reason=str(err.__cause__ or err)) from err
    await db.commit()
```

- [ ] **Step 4: Run** — `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest tests/test_initiative_status_scans_api.py tests/test_initiative_assets_api.py tests/test_status_provenance.py -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_status_scans_api.py
git commit -m "feat(initiatives): status edits record a manual scan and run rules in-request"
```

---

### Task 4: Portal — rule-failure message in the Edit dialog

**Files:**
- Modify: `portal/src/components/initiatives/AssetEditDialog.tsx` (catch block ~line 73)
- Test: `portal/src/components/initiatives/AssetEditDialog.test.tsx` (new)

**Interfaces:**
- Consumes: 409 `rule_failed` `{code, rule_name, reason}` in `ApiError.detail` (Task 3).

- [ ] **Step 1: Write the failing test** — `AssetEditDialog.test.tsx` (mock `../../lib/api` with `vi.hoisted`; keep `ApiError` real via `importOriginal`; render the dialog with a minimal `asset` row — copy the `makeRow`/`makeAsset` factories from `RackViewModal.render.test.tsx` — and any other required props the component declares; click its Save button):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateInitiativeAsset: vi.fn() }));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  ...api,
}));

import AssetEditDialog from './AssetEditDialog';
import { ApiError } from '../../lib/api';

afterEach(cleanup);

describe('AssetEditDialog rule failures', () => {
  it('shows which rule failed and why', async () => {
    api.updateInitiativeAsset.mockRejectedValue(new ApiError(409, 'rule_failed', {
      code: 'rule_failed', rule_name: 'Stage it', reason: 'unknown status no-such-status',
    }));
    render(<AssetEditDialog asset={makeRow()} statuses={[]} onClose={() => {}}
                            onSaved={async () => {}} />);
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText("Rule 'Stage it' failed: unknown status no-such-status"))
      .toBeTruthy();
  });
});
```

(Adjust the prop names to the component's actual signature — read its `export default function AssetEditDialog({...})` first.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/initiatives/AssetEditDialog.test.tsx`.

- [ ] **Step 3: Implement** — in the catch block:

```tsx
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rule_failed') {
        const d = err.detail as { rule_name?: string; reason?: string } | undefined;
        setError(`Rule '${d?.rule_name ?? '?'}' failed: ${d?.reason ?? 'unknown error'}`);
      } else {
        setError(err instanceof ApiError
          ? (MOVE_ASSET_ERRORS[err.code] ?? 'Could not save — try again.')
          : 'Network error.');
      }
    } finally {
```

- [ ] **Step 4: Run** — `npx vitest run src/components/initiatives/AssetEditDialog.test.tsx && npx tsc --noEmit -p .` → pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/initiatives/AssetEditDialog.tsx portal/src/components/initiatives/AssetEditDialog.test.tsx
git commit -m "feat(portal): edit dialog explains a failed status rule"
```

---

### Task 5: Verification (controller-led)

- [ ] Full API suite: `SS_TEST_DB=serversherpa_test_main .venv/bin/python -m pytest -q` (foreground, 600000ms) → all pass.
- [ ] Full portal suite + build: `npx vitest run && npm run build` → all pass.
- [ ] Live: on NAP11 Hall Migration (demo), Edit list → change one asset's status → Admin → Scans shows a new **Manual** row (device `portal`, source `initiative_asset_edit`, operator Claude Dev); the status chip's provenance hover shows Manual; with a deliberately broken rule enabled, the edit is refused with the rule's name and nothing changes; disable the rule afterwards.
- [ ] Fix anything found, commit.
