# Merge Duplicate Models and Catalog Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold a duplicate catalog model into the correct one (assets, stock lines, aliases move; blank specs fill; notes append; duplicate deleted; audited), and give Makes / Models a Review view listing importer-created models and likely duplicates with Merge / Edit / Dismiss.

**Architecture:** One migration adds `asset_models.review_dismissed_at`. A pure planning module `assets/merge.py` builds a merge plan (moves, fills, alias outcome, conflicts) that both the dry run and the real run use; the route applies it in one transaction. A review module groups models by the importer's `normalize_model_key`. Portal: a `ModelMergeModal` and a Review mode on the existing page.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic, pytest (asyncio auto). React 18, TypeScript, Vite, Vitest with jsdom.

Spec: `docs/superpowers/specs/2026-09-22-model-merge-and-review-design.md`.

## Global Constraints

- Work in the git worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/model-merge`, branch `model-merge-review`. Run every command from that directory. Never `cd` to the primary checkout.
- `api/.venv`, `portal/node_modules` and `.env` are symlinks to the primary checkout. Never `npm install` or `pip install`. Never commit `api/src/serversherpa/_dev_reload.py` or the `.env` symlink.
- API tests: always `SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest <files> -q`. One pytest process at a time. Targeted files per task; the full API suite runs once, in Task 5.
- Portal tests: the whole suite plus the type check from the worktree root: `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)`; one file via `(cd portal && node_modules/.bin/vitest run <path>)`. The list-typography guardrail rejects `font-size`/`line-height` on selectors containing "row"/"chip"/"head": put typography on a parent selector or use `font: inherit`.
- Migration `0070`, `down_revision = "0069"` (main already carries 0069).
- Merge rules (binding, from the spec): moves = assets + stock lines + source aliases (dropping any equal, case-insensitively, to the target's name or an existing target alias); alias added = source `"{make} {model}"` unless it equals the target's name or an existing target alias; conflicts = source alias or source name owned as an alias by a third model → `can_merge=false`, real run 409 `alias_conflict`; fills = single fields `category, ru_size, mount_type, rail_type, form_factor` when target is null/empty and source is not; unit pairs fill as whole groups (`weight_lbs`+`weight_kg` when both target values are null; the six dimension fields as one group when all six target values are null) using the source's values; notes = `target.rstrip() + "\n\nMerged from {make} {model} on {YYYY-MM-DD}."` + (`"\n" + source.strip()` if source notes) with leading blank lines trimmed when the target had none; source deleted; audits `merge` on target and `merged_into` on source; one commit; dry run writes nothing.
- Review rules: imported = `knowledge` starts with `FORCED:` (case-insensitive) and not dismissed; duplicates = union-find over `normalize_model_key` of `"{make} {model}"` and of every alias, groups of ≥2, members ordered asset count desc then name, groups by first member's name; `include_dismissed` toggles dismissed rows; `dismissed_count` always total.
- Portal labels: toolbar switch "All" / "Review"; sections "Created by import" and "Likely duplicates"; actions "Merge into…", "Edit", "Dismiss", "Restore"; checkbox "Show dismissed (N)"; dialog title "Merge into another model", primary button "Merge".
- Every new modal uses the report-generate header (`modal-card reports-modal-card rgm-card`, `modal-head` with `rgm-head-text` → `eyebrow` / `h3` / `page-hint`, `modal-close`, `modal-body`, `modal-foot` with `btn-solid` + `mini-btn` + inline `pf-error`) and sizes to its content.
- American English. Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: append one line per task to `.superpowers/sdd/progress.md`.

---

### Task 1: Migration 0070, review detection and dismiss endpoints

**Files:**
- Create: `api/migrations/versions/0070_model_review_dismissed.py`
- Create: `api/src/serversherpa/assets/review.py`
- Modify: `api/src/serversherpa/db/models.py:578-582` (`AssetModel`, after `knowledge`)
- Modify: `api/src/serversherpa/api/schemas.py:1123-1146` (`AssetModelItem` + new schemas)
- Modify: `api/src/serversherpa/api/routes/asset_models.py` (`_item`, two new routes placed BEFORE `GET /{model_id}` so `/review` is not captured by the uuid path)
- Test: create `api/tests/test_asset_model_review_api.py`

**Interfaces:**
- Produces: `AssetModel.review_dismissed_at: datetime | None`; `AssetModelItem.review_dismissed_at`; `assets/review.py::review_groups(models, aliases_by_model) -> list[list[AssetModel]]` (pure, union-find over normalized keys); `GET /asset-models/review`, `POST /asset-models/{id}/review`; `ModelSummary`/`ReviewItem` schemas with `asset_count`, `stock_line_count`; helper `_counts(db, model_ids) -> dict[uuid, tuple[int, int]]` in the route module (assets, stock lines per model) reused by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_asset_model_review_api.py`:

```python
"""GET /asset-models/review (imported + likely duplicates) and dismiss/restore."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Site, StockLine,
)
from tests.test_assets_api import login


async def _model(db, make, model, *, knowledge="", aliases=(), assets=0):
    m = AssetModel(make=make, model=model, knowledge=knowledge)
    db.add(m)
    await db.flush()
    for a in aliases:
        db.add(AssetModelAlias(model_id=m.id, alias=a))
    for i in range(assets):
        db.add(Asset(serial_number=f"{make}-{model}-{i}".lower(), model_id=m.id))
    await db.commit()
    return m


async def test_review_lists_imported_and_duplicate_groups(client, db, seeded_user):
    hdrs = await login(client)
    forced = await _model(db, "Dell", "R740 (Node)",
                          knowledge="FORCED: make model creation for move F-T", assets=1)
    a = await _model(db, "Dell", "PowerEdge R740", assets=3)
    b = await _model(db, "Dell", "PowerEdge_R740", assets=1)          # underscore -> same key
    c = await _model(db, "HPE", "DL380", aliases=("Dell PowerEdge R740 2U",))  # alias key joins the group
    lone = await _model(db, "Cisco", "C9300")
    resp = await client.get("/asset-models/review", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [m["id"] for m in body["imported"]] == [str(forced.id)]
    assert body["imported"][0]["reason"] == "imported"
    assert body["imported"][0]["asset_count"] == 1
    assert len(body["duplicates"]) == 1
    group = body["duplicates"][0]
    assert [m["id"] for m in group] == [str(a.id), str(b.id), str(c.id)]   # 3 assets first, then name
    assert group[0]["group_key"] == "dell poweredge r740"
    assert all(m["reason"] == "duplicate" for m in group)
    assert str(lone.id) not in {m["id"] for g in body["duplicates"] for m in g}
    assert body["dismissed_count"] == 0


async def test_dismiss_hides_restore_shows_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    forced = await _model(db, "Dell", "R740 (Node)", knowledge="forced: hybrid")
    resp = await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                             json={"dismissed": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["review_dismissed_at"] is not None
    body = (await client.get("/asset-models/review", headers=hdrs)).json()
    assert body["imported"] == [] and body["dismissed_count"] == 1
    body = (await client.get("/asset-models/review?include_dismissed=true",
                             headers=hdrs)).json()
    assert [m["id"] for m in body["imported"]] == [str(forced.id)]
    assert body["imported"][0]["review_dismissed_at"] is not None
    # no-op dismiss writes no second audit row
    await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                      json={"dismissed": True})
    resp = await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                             json={"dismissed": False})
    assert resp.json()["review_dismissed_at"] is None
    actions = [r.action for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.entity_id == str(forced.id)))]
    assert actions == ["review.dismiss", "review.restore"]


async def test_dismissed_model_leaves_its_duplicate_group(client, db, seeded_user):
    hdrs = await login(client)
    a = await _model(db, "Dell", "R640")
    b = await _model(db, "Dell", "R640 2U")
    await client.post(f"/asset-models/{b.id}/review", headers=hdrs, json={"dismissed": True})
    body = (await client.get("/asset-models/review", headers=hdrs)).json()
    assert body["duplicates"] == []       # a group of one is not a group
    assert str(a.id) not in {m["id"] for g in body["duplicates"] for m in g}


async def test_review_guards(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post(f"/asset-models/{uuid.uuid4()}/review", headers=hdrs,
                             json={"dismissed": True})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "asset_model_not_found"
```

Read `api/tests/test_assets_api.py::login` — alice is seeded with an admin-level role there; if `asset_models:change` is not granted to that role, use `tests.test_access_roles_api.login_admin` instead in these tests and say so in the report.

- [ ] **Step 2: Run to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_review_api.py -q`
Expected: FAIL (404 / 405, or 422 because `/review` is parsed as a uuid). The first run creates and migrates the branch test database.

- [ ] **Step 3: Migration and ORM column**

Create `api/migrations/versions/0070_model_review_dismissed.py`:

```python
"""Catalog review dismissals.

`asset_models.review_dismissed_at` marks a model an admin has looked at on
the Makes / Models Review view (importer-created rows and likely
duplicates) and decided to keep as is. Null means "not reviewed".

Revision ID: 0070
Revises: 0069
Create Date: 2026-09-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0070"
down_revision: str | None = "0069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("asset_models", sa.Column(
        "review_dismissed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("asset_models", "review_dismissed_at")
```

In `db/models.py`, class `AssetModel`, after the `knowledge` line: `review_dismissed_at: Mapped[datetime | None]`. Check the file's other timezone-aware timestamps (e.g. `archived_at` on `Asset`) and declare it the same way.

- [ ] **Step 4: Review grouping module**

Create `api/src/serversherpa/assets/review.py`:

```python
"""Catalog review: which models an admin should look at.

Imported rows carry the importer's "FORCED:" note. Likely duplicates are
models whose normalized name, or any alias, collides with another model's;
union-find joins A~B and B~C into one group. Pure functions over ORM rows
so the route stays a thin query layer."""

import uuid

from serversherpa.db.models import AssetModel
from serversherpa.imports.move_assets import normalize_model_key

FORCED_PREFIX = "forced:"


def is_imported(m: AssetModel) -> bool:
    return (m.knowledge or "").lstrip().lower().startswith(FORCED_PREFIX)


def model_keys(m: AssetModel, aliases: list[str]) -> set[str]:
    keys = {normalize_model_key(f"{m.make} {m.model}")}
    keys |= {normalize_model_key(a) for a in aliases}
    return {k for k in keys if k}


def duplicate_groups(
    models: list[AssetModel], aliases_by_model: dict[uuid.UUID, list[str]],
    counts: dict[uuid.UUID, tuple[int, int]],
) -> list[tuple[str, list[AssetModel]]]:
    """Groups of two or more models sharing a normalized key. Each group is
    (key, members) with members ordered by asset count desc then name and
    groups by their first member's name."""
    parent: dict[uuid.UUID, uuid.UUID] = {m.id: m.id for m in models}

    def find(x: uuid.UUID) -> uuid.UUID:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: uuid.UUID, b: uuid.UUID) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    owner_by_key: dict[str, uuid.UUID] = {}
    key_of_group: dict[uuid.UUID, str] = {}
    for m in models:
        for key in model_keys(m, aliases_by_model.get(m.id, [])):
            if key in owner_by_key:
                union(owner_by_key[key], m.id)
                key_of_group[find(m.id)] = key
            else:
                owner_by_key[key] = m.id

    members: dict[uuid.UUID, list[AssetModel]] = {}
    for m in models:
        members.setdefault(find(m.id), []).append(m)

    def name(m: AssetModel) -> str:
        return f"{m.make} {m.model}".lower()

    groups = []
    for root, ms in members.items():
        if len(ms) < 2:
            continue
        ms.sort(key=lambda m: (-counts.get(m.id, (0, 0))[0], name(m)))
        # the key the first two members actually share, for display
        shared = set.intersection(*(model_keys(m, aliases_by_model.get(m.id, [])) for m in ms[:2]))
        key = next(iter(sorted(shared)), key_of_group.get(find(root), ""))
        groups.append((key, ms))
    groups.sort(key=lambda g: name(g[1][0]))
    return groups
```

- [ ] **Step 5: Schemas** — in `api/src/serversherpa/api/schemas.py`, add `review_dismissed_at: datetime | None = None` to `AssetModelItem` after `knowledge`, and after `AssetModelAliasesIn`:

```python
class ModelSummary(AssetModelItem):
    asset_count: int = 0
    stock_line_count: int = 0


class ReviewItem(ModelSummary):
    reason: Literal["imported", "duplicate"]
    group_key: str | None = None


class ReviewOut(BaseModel):
    imported: list[ReviewItem]
    duplicates: list[list[ReviewItem]]
    dismissed_count: int


class ReviewDismissIn(BaseModel):
    dismissed: bool
    model_config = ConfigDict(extra="forbid")
```

Confirm `Literal` is already imported in schemas.py (it is used by `LoginIn`).

- [ ] **Step 6: Routes** — in `api/src/serversherpa/api/routes/asset_models.py`:

Add `"review_dismissed_at": m.review_dismissed_at,` to `_item()` after `"knowledge"`. Add imports: `from sqlalchemy import func, select`, `from serversherpa.db.models import Asset, StockLine` (extend the existing import), `from serversherpa.assets.review import duplicate_groups, is_imported`, and the new schemas. Add the helper:

```python
async def _counts(db: DbSession, model_ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[int, int]]:
    """(assets, stock lines) referencing each model."""
    if not model_ids:
        return {}
    out = {mid: [0, 0] for mid in model_ids}
    for mid, n in (await db.execute(
        select(Asset.model_id, func.count()).where(Asset.model_id.in_(model_ids))
        .group_by(Asset.model_id))).all():
        out[mid][0] = n
    for mid, n in (await db.execute(
        select(StockLine.model_id, func.count()).where(StockLine.model_id.in_(model_ids))
        .group_by(StockLine.model_id))).all():
        out[mid][1] = n
    return {k: (v[0], v[1]) for k, v in out.items()}
```

Insert both routes **above** `get_asset_model` (`GET /{model_id}`):

```python
@router.get("/review", response_model=ReviewOut)
async def review_asset_models(
    db: DbSession,
    include_dismissed: bool = False,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> ReviewOut:
    all_models = (await db.scalars(
        select(AssetModel).order_by(AssetModel.make, AssetModel.model))).all()
    dismissed_count = sum(1 for m in all_models if m.review_dismissed_at is not None)
    models = [m for m in all_models
              if include_dismissed or m.review_dismissed_at is None]
    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [m.id for m in models])
    counts = await _counts(db, [m.id for m in models])

    def item(m: AssetModel, reason: str, key: str | None) -> ReviewItem:
        a, s = counts.get(m.id, (0, 0))
        return ReviewItem(**_item(m, cats, aliases), asset_count=a,
                          stock_line_count=s, reason=reason, group_key=key)

    imported = [item(m, "imported", None) for m in models if is_imported(m)]
    groups = [[item(m, "duplicate", key) for m in ms]
              for key, ms in duplicate_groups(models, aliases, counts)]
    return ReviewOut(imported=imported, duplicates=groups,
                     dismissed_count=dismissed_count)


@router.post("/{model_id}/review", response_model=AssetModelItem)
async def dismiss_asset_model_review(
    model_id: uuid.UUID,
    body: ReviewDismissIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> AssetModelItem:
    _require_global(actor)
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    currently = m.review_dismissed_at is not None
    if body.dismissed != currently:
        m.review_dismissed_at = datetime.now(UTC) if body.dismissed else None
        audit(db, actor_id=actor.person.id, entity_type="asset_model",
              entity_id=str(model_id),
              action="review.dismiss" if body.dismissed else "review.restore")
        await db.commit()
    return await _detail(db, m)
```

- [ ] **Step 7: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_review_api.py api/tests/test_asset_models_api.py api/tests/test_assets_v2_model_catalog.py -q`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add api/migrations/versions/0070_model_review_dismissed.py api/src/serversherpa/assets/review.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/asset_models.py api/tests/test_asset_model_review_api.py
git commit -m "feat(catalog): review view data — importer-created models, likely-duplicate groups, dismiss/restore (migration 0070)"
```

---

### Task 2: Merge plan and `POST /asset-models/{target_id}/merge`

**Files:**
- Create: `api/src/serversherpa/assets/merge.py`
- Modify: `api/src/serversherpa/api/schemas.py` (`MergeIn`, `MergeConflict`, `MergePlanOut`)
- Modify: `api/src/serversherpa/api/routes/asset_models.py` (route after `set_asset_model_aliases`)
- Test: create `api/tests/test_asset_model_merge_api.py`

**Interfaces:**
- Consumes: Task 1's `_counts`, `ModelSummary`.
- Produces: `assets/merge.py::build_plan(db, target, source) -> MergePlan` (dataclass: `moves`, `fills`, `alias_added`, `aliases_moved`, `aliases_after`, `conflicts`, `notes_after`) and `apply_plan(db, target, source, plan, now) -> None` (writes, no commit); the route.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_asset_model_merge_api.py`:

```python
"""POST /asset-models/{target}/merge — dry run, apply, fills, aliases, guards."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Site, StockLine,
)
from tests.test_asset_model_review_api import _model
from tests.test_assets_api import login


async def _stock(db, model_id):
    site = Site(name="WH", site_type="warehouse")
    db.add(site)
    await db.flush()
    db.add(StockLine(site_id=site.id, description="spare", quantity=2, model_id=model_id))
    await db.commit()


async def test_dry_run_plans_moves_fills_and_alias_without_writing(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "PowerEdge R740", aliases=("R740",), assets=2)
    source = await _model(db, "Dell", "PowerEdge_R740", aliases=("r740", "Dell R740 2U"),
                          knowledge="FORCED: make model creation for move F-T", assets=3)
    source.ru_size = 2
    source.weight_lbs, source.weight_kg = Decimal("50.00"), Decimal("22.68")
    source.rail_type = "B7"
    await db.commit()
    await _stock(db, source.id)

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": True})
    assert resp.status_code == 200, resp.text
    plan = resp.json()
    assert plan["applied"] is False and plan["can_merge"] is True
    assert plan["moves"] == {"assets": 3, "stock_lines": 1, "aliases": 1}   # "r740" dropped (target has R740)
    assert plan["fills"] == {"ru_size": 2, "weight_lbs": 50.0, "weight_kg": 22.68, "rail_type": "B7"}
    assert plan["alias_added"] == "Dell PowerEdge_R740"
    assert sorted(plan["aliases_after"]) == sorted(["R740", "Dell R740 2U", "Dell PowerEdge_R740"])
    assert plan["conflicts"] == []
    assert plan["source"]["asset_count"] == 3 and plan["target"]["asset_count"] == 2
    # nothing written
    assert await db.get(AssetModel, source.id) is not None
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "merge")) is None


async def test_merge_applies_everything_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "PowerEdge R740", knowledge="Slide latches stick.", assets=1)
    target.length_in, target.width_in, target.height_in = Decimal("30"), Decimal("17"), Decimal("3.5")
    target.length_cm, target.width_cm, target.height_cm = Decimal("76.2"), Decimal("43.18"), Decimal("8.89")
    source = await _model(db, "Dell", "PowerEdge_R740", aliases=("Dell R740 2U",),
                          knowledge="FORCED: hybrid", assets=2)
    source.category = "server"
    source.length_in = Decimal("31")       # target's dims are set -> no fill
    await db.commit()
    await _stock(db, source.id)

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] is True
    await db.refresh(target)
    assert await db.get(AssetModel, source.id) is None
    assert await db.scalar(select(AssetModel).where(AssetModel.id == source.id)) is None
    n = await db.scalar(select(Asset.id).where(Asset.model_id == target.id).limit(10))
    assets = list(await db.scalars(select(Asset.id).where(Asset.model_id == target.id)))
    assert len(assets) == 3
    assert await db.scalar(select(StockLine.model_id).limit(1)) == target.id
    aliases = set(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == target.id)))
    assert aliases == {"Dell R740 2U", "Dell PowerEdge_R740"}
    assert target.category == "server"
    assert target.length_in == Decimal("30.00")        # untouched
    assert target.knowledge.startswith("Slide latches stick.\n\nMerged from Dell PowerEdge_R740 on ")
    assert target.knowledge.endswith("\nFORCED: hybrid")
    rows = {r.action: r for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.action.in_(("merge", "merged_into"))))}
    assert rows["merge"].entity_id == str(target.id)
    assert rows["merge"].changes["moves"] == {"assets": 2, "stock_lines": 1, "aliases": 1}
    assert rows["merge"].changes["fills"] == {"category": "server"}
    assert rows["merged_into"].entity_id == str(source.id)
    assert rows["merged_into"].changes["target_id"] == str(target.id)


async def test_notes_when_target_has_none(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "HPE", "DL380")
    source = await _model(db, "HPE", "DL 380")
    await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                      json={"source_id": str(source.id), "dry_run": False})
    await db.refresh(target)
    assert target.knowledge.startswith("Merged from HPE DL 380 on ")


async def test_alias_conflict_blocks_real_run(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "R640")
    source = await _model(db, "Dell", "R-640", aliases=("R640 rack",))
    third = await _model(db, "Dell", "R650", aliases=("Dell R-640",))    # owns the source's NAME as alias
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": True})
    plan = resp.json()
    assert plan["can_merge"] is False
    assert plan["conflicts"] == [{"alias": "Dell R-640", "model_id": str(third.id),
                                  "make": "Dell", "model": "R650"}]
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "alias_conflict"
    assert await db.get(AssetModel, source.id) is not None


async def test_merge_guards(client, db, seeded_user):
    hdrs = await login(client)
    a = await _model(db, "Dell", "R740")
    resp = await client.post(f"/asset-models/{a.id}/merge", headers=hdrs,
                             json={"source_id": str(a.id), "dry_run": True})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "cannot_merge_self"
    resp = await client.post(f"/asset-models/{a.id}/merge", headers=hdrs,
                             json={"source_id": str(uuid.uuid4()), "dry_run": True})
    assert resp.status_code == 404
    resp = await client.post(f"/asset-models/{uuid.uuid4()}/merge", headers=hdrs,
                             json={"source_id": str(a.id), "dry_run": True})
    assert resp.status_code == 404
```

Remove the stray `n = await db.scalar(...)` line in the second test when transcribing (it is a no-op). `asset_categories` must contain `server` in the test seed — `test_asset_models_api.py` already creates models with `"category": "server"`, so it does.

- [ ] **Step 2: Run to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_merge_api.py -q`
Expected: FAIL (404/405).

- [ ] **Step 3: Merge module** — create `api/src/serversherpa/assets/merge.py`:

```python
"""Merge one catalog model (the duplicate) into another (the target).

`build_plan` is pure: it reads what would move, which target specs the
duplicate would fill, what happens to every alias, and which aliases a
third model already owns. The dry run returns the plan; the real run
applies exactly the same plan. Rules are in the design spec."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, AssetModel, AssetModelAlias, StockLine

SINGLE_FIELDS = ("category", "ru_size", "mount_type", "rail_type", "form_factor")
UNIT_GROUPS = (("weight_lbs", "weight_kg"),
               ("length_in", "width_in", "height_in", "length_cm", "width_cm", "height_cm"))


@dataclass
class MergePlan:
    moves: dict = field(default_factory=lambda: {"assets": 0, "stock_lines": 0, "aliases": 0})
    fills: dict = field(default_factory=dict)
    alias_added: str | None = None
    aliases_moved: list[str] = field(default_factory=list)
    aliases_after: list[str] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    notes_after: str = ""

    @property
    def can_merge(self) -> bool:
        return not self.conflicts


def _name(m: AssetModel) -> str:
    return f"{m.make} {m.model}"


def _blank(v) -> bool:
    return v is None or v == ""


def merged_notes(target_notes: str, source: AssetModel, now: datetime) -> str:
    line = f"Merged from {_name(source)} on {now:%Y-%m-%d}."
    head = (target_notes or "").rstrip()
    out = f"{head}\n\n{line}" if head else line
    tail = (source.knowledge or "").strip()
    return f"{out}\n{tail}" if tail else out


async def build_plan(db: AsyncSession, target: AssetModel, source: AssetModel,
                     now: datetime) -> MergePlan:
    plan = MergePlan()
    plan.moves["assets"] = await db.scalar(
        select(func.count()).select_from(Asset).where(Asset.model_id == source.id)) or 0
    plan.moves["stock_lines"] = await db.scalar(
        select(func.count()).select_from(StockLine).where(StockLine.model_id == source.id)) or 0

    target_aliases = list(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == target.id).order_by(AssetModelAlias.alias)))
    source_aliases = list(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == source.id).order_by(AssetModelAlias.alias)))
    taken = {a.lower() for a in target_aliases} | {_name(target).lower()}

    candidates = list(source_aliases) + [_name(source)]
    owners = (await db.execute(
        select(AssetModelAlias.alias, AssetModel.id, AssetModel.make, AssetModel.model)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id)
        .where(func.lower(AssetModelAlias.alias).in_([c.lower() for c in candidates]),
               AssetModelAlias.model_id.not_in([target.id, source.id])))).all()
    plan.conflicts = [{"alias": alias, "model_id": str(mid), "make": mk, "model": md}
                      for alias, mid, mk, md in owners]

    for alias in source_aliases:
        if alias.lower() not in taken:
            plan.aliases_moved.append(alias)
            taken.add(alias.lower())
    plan.moves["aliases"] = len(plan.aliases_moved)
    if _name(source).lower() not in taken:
        plan.alias_added = _name(source)
        taken.add(_name(source).lower())
    plan.aliases_after = sorted(target_aliases + plan.aliases_moved
                                + ([plan.alias_added] if plan.alias_added else []),
                                key=str.lower)

    for f in SINGLE_FIELDS:
        if _blank(getattr(target, f)) and not _blank(getattr(source, f)):
            plan.fills[f] = getattr(source, f)
    for group in UNIT_GROUPS:
        if all(_blank(getattr(target, f)) for f in group) and \
                any(not _blank(getattr(source, f)) for f in group):
            for f in group:
                v = getattr(source, f)
                plan.fills[f] = float(v) if v is not None else None
    plan.notes_after = merged_notes(target.knowledge, source, now)
    return plan


async def apply_plan(db: AsyncSession, target: AssetModel, source: AssetModel,
                     plan: MergePlan, now: datetime) -> None:
    await db.execute(update(Asset).where(Asset.model_id == source.id)
                     .values(model_id=target.id, updated_at=now))
    await db.execute(update(StockLine).where(StockLine.model_id == source.id)
                     .values(model_id=target.id))
    moved = {a.lower() for a in plan.aliases_moved}
    for row in list(await db.scalars(select(AssetModelAlias).where(
            AssetModelAlias.model_id == source.id))):
        if row.alias.lower() in moved:
            row.model_id = target.id
        else:
            await db.delete(row)
    if plan.alias_added:
        db.add(AssetModelAlias(model_id=target.id, alias=plan.alias_added))
    for f, v in plan.fills.items():
        setattr(target, f, v)
    target.knowledge = plan.notes_after
    target.updated_at = now
    await db.flush()
    await db.delete(source)
    await db.flush()
```

Check whether `Asset` has `updated_at` (it does, `db/models.py`); if `StockLine` has one, bump it too.

- [ ] **Step 4: Schemas** — add to `schemas.py` after `ReviewDismissIn`:

```python
class MergeIn(BaseModel):
    source_id: uuid.UUID
    dry_run: bool = False
    model_config = ConfigDict(extra="forbid")


class MergeConflict(BaseModel):
    alias: str
    model_id: uuid.UUID
    make: str
    model: str


class MergePlanOut(BaseModel):
    target: ModelSummary
    source: ModelSummary
    moves: dict[str, int]
    fills: dict[str, float | int | str | None]
    alias_added: str | None
    aliases_after: list[str]
    conflicts: list[MergeConflict]
    can_merge: bool
    applied: bool
```

- [ ] **Step 5: Route** — in `asset_models.py`, after `set_asset_model_aliases`:

```python
@router.post("/{target_id}/merge", response_model=MergePlanOut)
async def merge_asset_model(
    target_id: uuid.UUID,
    body: MergeIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> MergePlanOut:
    """Fold `source_id` into this model. Dry run returns the plan only."""
    _require_global(actor)
    if body.source_id == target_id:
        raise _err(409, "cannot_merge_self")
    target = await db.get(AssetModel, target_id)
    source = await db.get(AssetModel, body.source_id)
    if target is None or source is None:
        raise _err(404, "asset_model_not_found")
    now = datetime.now(UTC)
    plan = await build_plan(db, target, source, now)

    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [target.id, source.id])
    counts = await _counts(db, [target.id, source.id])

    def summary(m: AssetModel) -> ModelSummary:
        a, s = counts.get(m.id, (0, 0))
        return ModelSummary(**_item(m, cats, aliases), asset_count=a, stock_line_count=s)

    out = MergePlanOut(target=summary(target), source=summary(source),
                       moves=plan.moves, fills=plan.fills,
                       alias_added=plan.alias_added, aliases_after=plan.aliases_after,
                       conflicts=plan.conflicts, can_merge=plan.can_merge,
                       applied=False)
    if body.dry_run:
        return out
    if not plan.can_merge:
        raise _err(409, "alias_conflict", conflicts=plan.conflicts)
    source_name = f"{source.make} {source.model}"
    source_id = str(source.id)
    await apply_plan(db, target, source, plan, now)
    audit(db, actor_id=actor.person.id, entity_type="asset_model",
          entity_id=str(target.id), action="merge",
          changes={"source_id": source_id, "source_make_model": source_name,
                   "moves": plan.moves, "fills": plan.fills,
                   "alias_added": plan.alias_added,
                   "aliases_moved": plan.aliases_moved})
    audit(db, actor_id=actor.person.id, entity_type="asset_model",
          entity_id=source_id, action="merged_into",
          changes={"target_id": str(target.id),
                   "target_make_model": f"{target.make} {target.model}"})
    await db.commit()
    out.applied = True
    return out
```

Build the summaries before `apply_plan` (as above) because the source row is gone afterwards. Import `build_plan, apply_plan` from `serversherpa.assets.merge` and the new schemas.

- [ ] **Step 6: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_merge_api.py api/tests/test_asset_model_review_api.py api/tests/test_asset_models_api.py api/tests/test_warehouse_api.py -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/assets/merge.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/asset_models.py api/tests/test_asset_model_merge_api.py
git commit -m "feat(catalog): merge a duplicate model into another — moves, fills, aliases, notes, audit, dry run"
```

---

### Task 3: Portal — API client, ModelMergeModal

**Files:**
- Modify: `portal/src/lib/api.ts` (types + `reviewAssetModels`, `dismissAssetModelReview`, `mergeAssetModel`, after `setAssetModelAliases`; add `review_dismissed_at` to `AssetModelItem`)
- Modify: `portal/src/lib/assets.ts` (`MODEL_ERRORS` additions, `mergeFieldRows` helper)
- Create: `portal/src/components/assets/ModelMergeModal.tsx`
- Modify: `portal/src/styles/assets.css`
- Test: create `portal/src/components/assets/ModelMergeModal.test.tsx`, extend `portal/src/lib/assets.test.ts`

**Interfaces:**
- Produces: `mergeAssetModel(targetId, sourceId, dryRun): Promise<MergePlanOut>`; `ModelMergeModal` props `{ source: AssetModelItem; models: AssetModelItem[]; presetTargetId?: string | null; onClose(): void; onMerged(plan: MergePlanOut): void }`; `mergeFieldRows(target, source, fills)` returning `{ label, keep, dup, result }[]` for the side-by-side table.

- [ ] **Step 1: Types and API** in `lib/api.ts`:

Add `review_dismissed_at: string | null;` to `AssetModelItem` after `knowledge`. Then:

```ts
export interface ModelSummary extends AssetModelItem { asset_count: number; stock_line_count: number }
export interface ReviewItem extends ModelSummary { reason: 'imported' | 'duplicate'; group_key: string | null }
export interface ReviewOut { imported: ReviewItem[]; duplicates: ReviewItem[][]; dismissed_count: number }
export interface MergeConflict { alias: string; model_id: string; make: string; model: string }
export interface MergePlanOut {
  target: ModelSummary; source: ModelSummary;
  moves: { assets: number; stock_lines: number; aliases: number };
  fills: Record<string, number | string | null>;
  alias_added: string | null; aliases_after: string[];
  conflicts: MergeConflict[]; can_merge: boolean; applied: boolean;
}

export async function reviewAssetModels(includeDismissed = false): Promise<ReviewOut> {
  const resp = await apiFetch(`/asset-models/review?include_dismissed=${includeDismissed}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function dismissAssetModelReview(id: string, dismissed: boolean): Promise<AssetModelItem> {
  const resp = await apiFetch(`/asset-models/${id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dismissed }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function mergeAssetModel(targetId: string, sourceId: string, dryRun: boolean): Promise<MergePlanOut> {
  const resp = await apiFetch(`/asset-models/${targetId}/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, dry_run: dryRun }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Run `(cd portal && node_modules/.bin/tsc --noEmit)` and add `review_dismissed_at: null` to every `AssetModelItem` fixture it flags (known: `portal/src/lib/assets.test.ts` `assetModel()` builder; check `FixMakeModelDialog.test.tsx`, `StockLineModal.test.tsx`, `Warehouse.test.tsx`, `AssetEditModal` tests).

- [ ] **Step 2: Helpers in `lib/assets.ts`**

Extend `MODEL_ERRORS`:

```ts
  cannot_merge_self: 'A model cannot be merged into itself.',
  alias_conflict: 'An alias on the duplicate belongs to a third model — remove it there first.',
  asset_model_not_found: 'That model was already merged or deleted — refresh and try again.',
```

Add:

```ts
export interface MergeFieldRow { key: string; label: string; keep: string; dup: string; result: string }

const MERGE_FIELDS: [string, string, (m: AssetModelItem) => string][] = [
  ['category', 'Category', (m) => m.category_label ?? m.category ?? '—'],
  ['ru_size', 'RU size', (m) => (m.ru_size !== null ? String(m.ru_size) : '—')],
  ['weight', 'Weight', (m) => (m.weight_lbs !== null ? `${m.weight_lbs} lb / ${m.weight_kg} kg` : '—')],
  ['dims', 'Dimensions (in)', (m) => formatDims(m.length_in, m.width_in, m.height_in, 'in')],
  ['mount_type', 'Mount type', (m) => titleCase(m.mount_type)],
  ['form_factor', 'Form factor', (m) => formFactorLabel(m.form_factor)],
  ['rail_type', 'Rail type', (m) => m.rail_type ?? '—'],
];

/** Side-by-side rows for the merge dialog: what the target keeps, what the
 *  duplicate has, and the result once the plan's fills are applied. */
export function mergeFieldRows(
  target: AssetModelItem, source: AssetModelItem, fills: Record<string, unknown>,
): MergeFieldRow[] {
  const filled = (key: string) => key === 'weight' ? 'weight_lbs' in fills
    : key === 'dims' ? 'length_in' in fills : key in fills;
  return MERGE_FIELDS.map(([key, label, read]) => ({
    key, label, keep: read(target), dup: read(source),
    result: filled(key) ? read(source) : read(target),
  }));
}
```

Tests in `portal/src/lib/assets.test.ts` (use the file's `assetModel()` builder; check how it is named there):

```ts
describe('mergeFieldRows', () => {
  it('shows the duplicate value as the result only where the plan fills', () => {
    const target = assetModel({ ru_size: null, rail_type: 'A1', weight_lbs: null, weight_kg: null });
    const source = assetModel({ ru_size: 2, rail_type: 'B7', weight_lbs: 50, weight_kg: 22.68 });
    const rows = mergeFieldRows(target, source, { ru_size: 2, weight_lbs: 50, weight_kg: 22.68 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.ru_size).toMatchObject({ keep: '—', dup: '2', result: '2' });
    expect(byKey.rail_type).toMatchObject({ keep: 'A1', dup: 'B7', result: 'A1' });
    expect(byKey.weight.result).toBe('50 lb / 22.68 kg');
  });
});
```

- [ ] **Step 3: Write the failing modal test** `portal/src/components/assets/ModelMergeModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ mergeAssetModel: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ModelMergeModal } = await import('./ModelMergeModal');

const model = (over: Record<string, unknown>) => ({
  id: 'm1', make: 'Dell', model: 'PowerEdge R740', category: null, category_label: null,
  category_color: null, ru_size: null, weight_lbs: null, weight_kg: null,
  length_in: null, width_in: null, height_in: null, length_cm: null, width_cm: null, height_cm: null,
  mount_type: null, rail_type: null, form_factor: null, knowledge: '', aliases: [],
  review_dismissed_at: null, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
}) as never;
const target = model({ id: 't1' });
const source = model({ id: 's1', model: 'PowerEdge_R740', ru_size: 2 });
const plan = {
  target: { ...target, asset_count: 2, stock_line_count: 0 },
  source: { ...source, asset_count: 3, stock_line_count: 1 },
  moves: { assets: 3, stock_lines: 1, aliases: 0 }, fills: { ru_size: 2 },
  alias_added: 'Dell PowerEdge_R740', aliases_after: ['Dell PowerEdge_R740'],
  conflicts: [], can_merge: true, applied: false,
};

beforeEach(() => { api.mergeAssetModel.mockReset(); });
afterEach(cleanup);

it('dry-runs on target pick, renders the plan, then merges', async () => {
  api.mergeAssetModel.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
  const onMerged = vi.fn();
  render(<ModelMergeModal source={source} models={[target, source]} presetTargetId="t1"
                          onClose={() => {}} onMerged={onMerged} />);
  await waitFor(() => expect(api.mergeAssetModel).toHaveBeenCalledWith('t1', 's1', true));
  expect(await screen.findByText('3 assets and 1 stock line move; 0 aliases move; alias added: Dell PowerEdge_R740')).toBeTruthy();
  expect(screen.getByText('RU size').closest('tr')!.textContent).toContain('2');
  fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
  await waitFor(() => expect(api.mergeAssetModel).toHaveBeenLastCalledWith('t1', 's1', false));
  await waitFor(() => expect(onMerged).toHaveBeenCalled());
});

it('conflicts disable Merge and are listed', async () => {
  api.mergeAssetModel.mockResolvedValueOnce({ ...plan, can_merge: false,
    conflicts: [{ alias: 'Dell R-640', model_id: 'x', make: 'Dell', model: 'R650' }] });
  render(<ModelMergeModal source={source} models={[target, source]} presetTargetId="t1"
                          onClose={() => {}} onMerged={() => {}} />);
  expect(await screen.findByText("‘Dell R-640’ already belongs to Dell R650 — remove it there first.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
});
```

Run: `(cd portal && node_modules/.bin/vitest run src/components/assets/ModelMergeModal.test.tsx)` → FAIL (module not found).

- [ ] **Step 4: `ModelMergeModal.tsx`**

```tsx
/**
 * ModelMergeModal — fold one catalog model (the duplicate) into another.
 * Picking the target runs a dry run; the side-by-side table shows what the
 * target keeps, what the duplicate has, and the result. Merge sends the
 * identical request for real. Conflicts (an alias a third model owns)
 * block the merge until they are fixed on that model.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, mergeAssetModel, type AssetModelItem, type MergePlanOut,
} from '../../lib/api';
import { MODEL_ERRORS, mergeFieldRows } from '../../lib/assets';
import ComboBox from '../ComboBox';

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function ModelMergeModal({ source, models, presetTargetId, onClose, onMerged }: {
  source: AssetModelItem;
  models: AssetModelItem[];
  presetTargetId?: string | null;
  onClose: () => void;
  onMerged: (plan: MergePlanOut) => void;
}) {
  const [targetId, setTargetId] = useState(presetTargetId ?? '');
  const [plan, setPlan] = useState<MergePlanOut | null>(null);
  const [busy, setBusy] = useState<'plan' | 'merge' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPlan(null);
    setError('');
    if (!targetId) return;
    let live = true;
    setBusy('plan');
    mergeAssetModel(targetId, source.id, true)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(msgFor(e)); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [targetId, source.id]);

  const merge = async () => {
    if (!plan) return;
    setBusy('merge');
    setError('');
    try {
      onMerged(await mergeAssetModel(targetId, source.id, false));
    } catch (e) {
      setError(msgFor(e));
      setBusy(null);
    }
  };

  const options = models.filter((m) => m.id !== source.id)
    .map((m) => ({ value: m.id, label: `${m.make} ${m.model}`, sub: m.category_label }));
  const rows = plan ? mergeFieldRows(plan.target, plan.source, plan.fills) : [];

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card model-merge-card" role="dialog" aria-label="Merge into another model">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Catalog</div>
            <h3>Merge into another model</h3>
            <p className="page-hint">Assets, stock lines and aliases move to the model you pick. The duplicate is deleted and its name becomes an alias.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={!!busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Duplicate</label>
              <div className="mm-source"><b>{source.make} {source.model}</b>
                {plan && <span> · {plural(plan.source.asset_count, 'asset', 'assets')}</span>}</div></div>
            <div className="full"><label>Merge into</label>
              <ComboBox options={options} value={targetId} placeholder="Type to search models…"
                        disabled={busy === 'merge'} onChange={setTargetId} /></div>
          </div>

          {busy === 'plan' && <p className="set-note">Working out what would move…</p>}
          {plan && (
            <div className="mm-plan">
              <table className="data-table mm-table">
                <thead><tr><th>Field</th><th>Keep · {plan.target.make} {plan.target.model}</th>
                  <th>{plan.source.make} {plan.source.model}</th><th>Result</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.result !== r.keep ? 'filled' : ''}>
                      <td>{r.label}</td><td>{r.keep}</td><td>{r.dup}</td><td>{r.result}</td>
                    </tr>
                  ))}
                  <tr><td>Notes</td><td>{plan.target.knowledge || '—'}</td>
                    <td>{plan.source.knowledge || '—'}</td><td>appended</td></tr>
                </tbody>
              </table>
              <p className="set-note">
                {plural(plan.moves.assets, 'asset', 'assets')} and {plural(plan.moves.stock_lines, 'stock line', 'stock lines')} move;
                {' '}{plan.moves.aliases} aliases move; alias added: {plan.alias_added ?? 'none'}
              </p>
              <div className="chips">
                {plan.aliases_after.length
                  ? plan.aliases_after.map((a) => <span key={a} className="chip tag">{a}</span>)
                  : <span className="chip tag">no aliases</span>}
              </div>
              {plan.conflicts.length > 0 && (
                <ul className="mm-conflicts">
                  {plan.conflicts.map((c) => (
                    <li key={c.alias}>‘{c.alias}’ already belongs to {c.make} {c.model} — remove it there first.</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!plan || !plan.can_merge || !!busy} onClick={() => void merge()}>
            {busy === 'merge' ? 'Merging…' : 'Merge'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
```

The plural helper must yield "0 aliases move" as the test expects (`{plan.moves.aliases} aliases move` as written).

- [ ] **Step 5: Styles** — append to `portal/src/styles/assets.css`:

```css
/* ── merge dialog ─────────────────────────────────────────── */
.modal-card.reports-modal-card.rgm-card.model-merge-card { width: min(820px, 96vw); max-width: 96vw; overflow: visible; max-height: none; }
.mm-source { padding: 8px 0; }
.mm-plan { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.mm-table td, .mm-table th { padding: 6px 10px; text-align: left; vertical-align: top; }
.mm-table tr.filled td:last-child { color: var(--c-green); font-weight: 600; }
.mm-conflicts { margin: 0; padding-left: 18px; color: var(--c-red); }
```

- [ ] **Step 6: Run the suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add portal/src
git commit -m "feat(portal): ModelMergeModal with dry-run plan, side-by-side specs and conflict blocking"
```

---

### Task 4: Portal — Review view and Merge action on Makes / Models

**Files:**
- Modify: `portal/src/pages/AssetModels.tsx` (toolbar switch, Review mode, row-detail action)
- Create: `portal/src/components/assets/ModelReviewPanel.tsx`
- Modify: `portal/src/styles/assets.css`
- Test: create `portal/src/components/assets/ModelReviewPanel.test.tsx`, create `portal/src/pages/AssetModels.test.tsx`

**Interfaces:**
- Consumes: Task 3's API functions and modal.
- Produces: `ModelReviewPanel` props `{ canChange: boolean; onMerge(source: AssetModelItem, presetTargetId: string | null): void; onEdit(id: string): void; reloadKey: number }` (it loads its own data via `reviewAssetModels`, re-fetching when `reloadKey` changes).

- [ ] **Step 1: Write the failing tests**

`portal/src/components/assets/ModelReviewPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ reviewAssetModels: vi.fn(), dismissAssetModelReview: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ModelReviewPanel } = await import('./ModelReviewPanel');

const item = (id: string, model: string, over: Record<string, unknown> = {}) => ({
  id, make: 'Dell', model, category: null, category_label: null, category_color: null,
  ru_size: null, weight_lbs: null, weight_kg: null, length_in: null, width_in: null, height_in: null,
  length_cm: null, width_cm: null, height_cm: null, mount_type: null, rail_type: null, form_factor: null,
  knowledge: '', aliases: [], review_dismissed_at: null, created_at: '', updated_at: '',
  asset_count: 1, stock_line_count: 0, reason: 'duplicate', group_key: 'dell r740', ...over,
});

beforeEach(() => {
  api.reviewAssetModels.mockReset();
  api.dismissAssetModelReview.mockReset();
  api.reviewAssetModels.mockResolvedValue({
    imported: [item('f1', 'R740 (Node)', { reason: 'imported', group_key: null,
      knowledge: 'FORCED: make model creation for move F-T\nmore' })],
    duplicates: [[item('a', 'PowerEdge R740', { asset_count: 3 }), item('b', 'PowerEdge_R740')]],
    dismissed_count: 2,
  });
});
afterEach(cleanup);

it('renders both sections and presets the other member on Merge into…', async () => {
  const onMerge = vi.fn();
  render(<ModelReviewPanel canChange onMerge={onMerge} onEdit={() => {}} reloadKey={0} />);
  expect(await screen.findByText('Created by import')).toBeTruthy();
  expect(screen.getByText('FORCED: make model creation for move F-T')).toBeTruthy();
  expect(screen.getByText('Likely duplicates')).toBeTruthy();
  expect(screen.getByText('Show dismissed (2)')).toBeTruthy();
  const row = screen.getByText('PowerEdge_R740').closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="merge"]')!);
  expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'a');
});

it('dismiss calls the API and refetches; show dismissed refetches with the flag', async () => {
  api.dismissAssetModelReview.mockResolvedValue({});
  render(<ModelReviewPanel canChange onMerge={() => {}} onEdit={() => {}} reloadKey={0} />);
  const row = (await screen.findByText('R740 (Node)')).closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="dismiss"]')!);
  await waitFor(() => expect(api.dismissAssetModelReview).toHaveBeenCalledWith('f1', true));
  await waitFor(() => expect(api.reviewAssetModels).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByLabelText('Show dismissed (2)'));
  await waitFor(() => expect(api.reviewAssetModels).toHaveBeenLastCalledWith(true));
});
```

`portal/src/pages/AssetModels.test.tsx` (mirror `Access.test.tsx`'s auth mock; mock `listAssetModels`, `listAssetCategories`, `reviewAssetModels`):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  listAssetModels: vi.fn(async () => []),
  listAssetCategories: vi.fn(async () => []),
  reviewAssetModels: vi.fn(async () => ({ imported: [], duplicates: [], dismissed_count: 0 })),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: AssetModels } = await import('./AssetModels');

it('switches to the Review view', async () => {
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: /Review/ }));
  expect(await screen.findByText('Nothing to review — the catalog has no import-created or overlapping models.')).toBeTruthy();
});
```

Run both: `(cd portal && node_modules/.bin/vitest run src/components/assets/ModelReviewPanel.test.tsx src/pages/AssetModels.test.tsx)` → FAIL.

- [ ] **Step 2: `ModelReviewPanel.tsx`**

```tsx
/**
 * ModelReviewPanel — the Makes / Models Review view: models the importer
 * created by guessing, and groups of models whose normalized names or
 * aliases collide. Each row offers Merge into…, Edit and Dismiss (Restore
 * for dismissed rows). Data is loaded here; the page bumps `reloadKey`
 * after any catalog write.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, dismissAssetModelReview, reviewAssetModels,
  type AssetModelItem, type ReviewItem, type ReviewOut,
} from '../../lib/api';
import { MODEL_ERRORS } from '../../lib/assets';

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

export default function ModelReviewPanel({ canChange, onMerge, onEdit, reloadKey }: {
  canChange: boolean;
  onMerge: (source: AssetModelItem, presetTargetId: string | null) => void;
  onEdit: (id: string) => void;
  reloadKey: number;
}) {
  const [data, setData] = useState<ReviewOut | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    reviewAssetModels(showDismissed)
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((e) => { if (live) setError(msgFor(e)); });
    return () => { live = false; };
  }, [showDismissed, reloadKey, tick]);

  const dismiss = async (m: ReviewItem, dismissed: boolean) => {
    setBusyId(m.id);
    setError('');
    try {
      await dismissAssetModelReview(m.id, dismissed);
      setTick((t) => t + 1);
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusyId(null);
    }
  };

  const row = (m: ReviewItem, presetTargetId: string | null, note?: string) => {
    const dismissed = m.review_dismissed_at !== null;
    return (
      <div key={m.id} className={`rv-row ${dismissed ? 'dismissed' : ''}`}>
        <div className="rv-main">
          <b>{m.make} {m.model}</b>
          <span className="rv-meta">{m.asset_count} asset{m.asset_count === 1 ? '' : 's'}
            {m.aliases.length > 0 && ` · ${m.aliases.length} alias${m.aliases.length === 1 ? '' : 'es'}`}
            {dismissed && ' · dismissed'}</span>
          {note && <span className="rv-note">{note}</span>}
        </div>
        {canChange && (
          <div className="rv-actions">
            <button className="mini-btn accent" data-action="merge" disabled={busyId === m.id}
                    onClick={() => onMerge(m, presetTargetId)}>Merge into…</button>
            <button className="mini-btn" data-action="edit" disabled={busyId === m.id}
                    onClick={() => onEdit(m.id)}>Edit</button>
            <button className="mini-btn" data-action={dismissed ? 'restore' : 'dismiss'} disabled={busyId === m.id}
                    onClick={() => void dismiss(m, !dismissed)}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          </div>
        )}
      </div>
    );
  };

  if (error && !data) return <div className="dir-empty"><b>Cannot load review</b>{error}</div>;
  if (!data) return <p className="page-hint">Loading…</p>;
  const empty = data.imported.length === 0 && data.duplicates.length === 0;

  return (
    <div className="rv-panel">
      <label className="init-check rv-toggle">
        <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
        Show dismissed ({data.dismissed_count})
      </label>
      {error && <span className="pf-error">{error}</span>}
      {empty && (
        <div className="dir-empty"><b>Nothing to review</b>Nothing to review — the catalog has no import-created or overlapping models.</div>
      )}
      {data.imported.length > 0 && (
        <section className="rv-section">
          <p className="eyebrow-sm">Created by import</p>
          {data.imported.map((m) => row(m, null, (m.knowledge || '').split('\n')[0]))}
        </section>
      )}
      {data.duplicates.length > 0 && (
        <section className="rv-section">
          <p className="eyebrow-sm">Likely duplicates</p>
          {data.duplicates.map((group) => (
            <div key={group.map((g) => g.id).join('+')} className="rv-group">
              <div className="rv-group-key">matches “{group[0].group_key}”</div>
              {group.map((m) => row(m, group.length === 2 ? group.find((g) => g.id !== m.id)!.id : null))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
```

The empty-state text in the page test is "Nothing to review — the catalog has no import-created or overlapping models." — keep that exact sentence as the text node after the bold label (the `dir-empty` idiom puts a `<b>` first).

- [ ] **Step 3: Wire the page** (`AssetModels.tsx`)

- Import `ModelMergeModal`, `ModelReviewPanel`, `useToast` from `'../lib/notificationsContext'`, and `type MergePlanOut`.
- State: `const [view, setView] = useState<'all' | 'review'>('all');`, `const [merging, setMerging] = useState<{ source: AssetModelItem; presetTargetId: string | null } | null>(null);`, `const [reviewKey, setReviewKey] = useState(0);`, `const toast = useToast();`.
- In the toolbar, before `toolbar-right`, the switch (Containers.tsx idiom):

```tsx
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''}
                  onClick={() => setView('all')}>All</button>
          <button role="tab" aria-selected={view === 'review'} className={view === 'review' ? 'on' : ''}
                  onClick={() => setView('review')}>Review</button>
        </div>
```

- Wrap the existing `{!error && (<div className="dir-list">…)}` block in `view === 'all' &&`, and add after it:

```tsx
      {!error && view === 'review' && (
        <ModelReviewPanel canChange={canChange} reloadKey={reviewKey}
                          onMerge={(source, presetTargetId) => setMerging({ source, presetTargetId })}
                          onEdit={(id) => setEditingId(id)} />
      )}
```

- Make every `onSaved={() => load()}` also bump `setReviewKey((k) => k + 1)`.
- `ModelRowDetail` gains a prop `onMerge: () => void` and renders, next to Edit when `canEdit`: `<button className="mini-btn accent" onClick={onMerge}>Merge into…</button>`; pass `onMerge={() => setMerging({ source: m, presetTargetId: null })}` from the row.
- Mount the modal:

```tsx
      {merging && models && (
        <ModelMergeModal source={merging.source} models={models} presetTargetId={merging.presetTargetId}
                         onClose={() => setMerging(null)}
                         onMerged={(plan: MergePlanOut) => {
                           setMerging(null);
                           toast(`Merged ${plan.source.make} ${plan.source.model} into ${plan.target.make} ${plan.target.model}: ${plan.moves.assets} asset${plan.moves.assets === 1 ? '' : 's'} moved`);
                           void load();
                           setReviewKey((k) => k + 1);
                           setOpenId(plan.target.id);
                         }} />
      )}
```

- [ ] **Step 4: Styles** — append to `assets.css`:

```css
/* ── catalog review view ──────────────────────────────────── */
.rv-panel { display: flex; flex-direction: column; gap: 16px; }
.rv-toggle { align-self: flex-end; }
.rv-section { display: flex; flex-direction: column; gap: 8px; }
.rv-group { border: 1px solid var(--c-amber-bd, rgba(255, 161, 46, 0.38)); border-radius: 12px; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.rv-group-key { color: var(--text-mute); padding-bottom: 4px; }
.rv-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 8px 12px; border-radius: 10px; background: var(--surface); }
.rv-row.dismissed { opacity: .6; }
.rv-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rv-meta, .rv-note { color: var(--text-mute); }
.rv-actions { display: flex; gap: 6px; }
```

The panel's typography rides the page defaults; do not put `font-size` on `.rv-row`/`.rv-group-key` (guardrail).

- [ ] **Step 5: Run the suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Makes / Models Review view (import-created, likely duplicates, dismiss) and Merge into… action"
```

---

### Task 5: Full suites

- [ ] `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib SS_TEST_DB=serversherpa_test_modelmerge PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests -q` → all PASS (about 22 minutes).
- [ ] `npm --prefix portal run test` and `(cd portal && node_modules/.bin/tsc --noEmit)` → all PASS.
- [ ] Append `Task 5: full suites green` to `.superpowers/sdd/progress.md`.
