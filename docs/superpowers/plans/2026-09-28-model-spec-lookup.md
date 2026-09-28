# Model Spec Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `spec-lookup-worker` that asks Claude (web search + web fetch) for missing RU / weight / dimensions (and optionally mounting and a knowledge note) per Makes / Models entry, verifies every value against a quoted source, and lands the results as reviewable suggestions (optionally auto-filling blank fields).

**Architecture:** New package `api/src/serversherpa/spec_lookup/` split by responsibility: `fields.py` (field groups ↔ columns), `verify.py` (pure checks), `provider.py` (the only code that talks to Claude), `service.py` (eligibility, enqueue, record, apply/approve/reject/undo), `jobs.py` + `worker.py` (queue + loop, copied from the label worker). One new route module, one migration, a System settings section, and three portal surfaces (Makes / Models tab, Settings tab, Developer › System Config tab).

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (Postgres), the official `anthropic` Python SDK (`AsyncAnthropic`), React + TypeScript + Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-model-spec-lookup-design.md`

## Global Constraints

- Migration number **0080**, `down_revision = "0073"` (0074–0079 belong to the unmerged `wiki` branch).
- Claude model default `claude-sonnet-5`; tools `web_search_20260209` / `web_fetch_20260209`; call through the official `anthropic` SDK only (never raw HTTP, never an OpenAI shim).
- Only make, model, aliases, category and the wanted field names are ever sent to Claude. A `private` model is never sent — checked at sweep time, at enqueue time, and again right before the call.
- Tests never call the real API: conftest pins `SS_ANTHROPIC_API_KEY=""`; tests inject a fake provider.
- Auto-apply only ever fills **blank** fields; knowledge suggestions never auto-apply.
- All spec-lookup routes call `_require_global` (client-anchored users refused), as `/asset-models` does.
- American English in all copy, comments and docs (color, organize, catalog).
- Portal: reuse existing idioms (`segmented`, `mini-btn`, `set-row` + `Switch`, `DataTable`, `dir-empty`, `pf-error`); never a raw `<table>` outside `DataTable.tsx`; never font-weight on td/th selectors (list-typography guardrail).
- Every bulk action ends in a per-row summary with CSV download (`BulkApplySummary`).

## Worktree setup (do once, before Task 1)

The worktree is `.claude/worktrees/spec-lookup` on branch `spec-lookup`. Nothing is committed for venv/node_modules, so:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/spec-lookup
ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv
ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules
cp /Users/jrh1812/Developer/BaseCampV3/.env .env
```

API test command used throughout (worktree sources must win over the main checkout's editable install; per-worktree test DB):

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/spec-lookup/api
PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_spec_lookup .venv/bin/pytest tests/<file> -q
```

Portal test command: `cd portal && npx vitest run <path>`. Subagents run suites in the **foreground**.

---

### Task 1: Dependency, env keys, settings fields

**Files:**
- Modify: `api/pyproject.toml` (dependencies list)
- Modify: `api/src/serversherpa/config.py:103-108` (after the AI assistant block)
- Modify: `.env.example` (after the `# ── AI assistant` block, ~line 73)
- Modify: `/Users/jrh1812/Developer/BaseCampV3/.env` (main checkout — the dev stack's env) and the worktree's copied `.env`
- Modify: `api/tests/conftest.py:~95` (`_prepare_environment`)
- Test: `api/tests/test_spec_lookup_config.py`

**Interfaces:**
- Produces: `Settings.anthropic_api_key: SecretStr`, `Settings.spec_lookup_model: str`, `Settings.spec_lookup_max_searches: int`, `Settings.spec_lookup_max_fetches: int`.

- [ ] **Step 1: Install the SDK into the shared venv and add the dependency**

```bash
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pip install "anthropic>=0.116"
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -c "import anthropic; print(anthropic.__version__)"
```

In `api/pyproject.toml` add to `dependencies` right after `"httpx>=0.27",`:

```toml
    "anthropic>=0.116",
```

- [ ] **Step 2: Write the failing test**

`api/tests/test_spec_lookup_config.py`:

```python
"""Spec lookup env settings: defaults, and tests never carry a real key."""
from serversherpa.config import Settings, get_settings


def test_defaults():
    s = Settings(_env_file=None)
    assert s.anthropic_api_key.get_secret_value() == ""
    assert s.spec_lookup_model == "claude-sonnet-5"
    assert s.spec_lookup_max_searches == 4
    assert s.spec_lookup_max_fetches == 3


def test_suite_never_has_a_real_key():
    assert get_settings().anthropic_api_key.get_secret_value() == ""
```

- [ ] **Step 3: Run it — expect FAIL** (`AttributeError: 'Settings' object has no attribute 'anthropic_api_key'`)

- [ ] **Step 4: Implement**

In `config.py`, directly after `ai_reasoning_effort: str = ""  ...`:

```python

    # ── Spec lookup (Claude API) ───────────────────────────
    # Makes / Models spec lookup via Claude web search. Empty key = not
    # configured: the worker idles and the portal says so.
    anthropic_api_key: SecretStr = SecretStr("")
    spec_lookup_model: str = "claude-sonnet-5"
    spec_lookup_max_searches: int = 4
    spec_lookup_max_fetches: int = 3
```

In `conftest.py` `_prepare_environment`, directly after `os.environ["SS_AI_ENABLED"] = "false"`:

```python
    # ...and never let a developer's real Anthropic key reach the suite.
    os.environ["SS_ANTHROPIC_API_KEY"] = ""
```

Append to `.env.example` right after the AI assistant block (and the same block, with the real values left empty, to the main checkout's `.env` after its `SS_AI_REASONING_EFFORT=none` line, and to the worktree `.env`):

```
# ── Spec lookup (Claude API) ─────────────────────────────
# Makes / Models spec lookup searches the web through Claude. Only make/model
# names are sent; models marked Private never are. Empty key = off.
SS_ANTHROPIC_API_KEY=
SS_SPEC_LOOKUP_MODEL=claude-sonnet-5
SS_SPEC_LOOKUP_MAX_SEARCHES=4
SS_SPEC_LOOKUP_MAX_FETCHES=3
```

(`SS_ANTHROPIC_API_KEY` matches env_file's secret heuristic (`KEY`), so the System Config Environment tab masks it and keeps it on empty save — no change needed there.)

- [ ] **Step 5: Run it — expect PASS**, plus `tests/test_env_file.py tests/test_env_api.py -q` still pass.

- [ ] **Step 6: Commit**

```bash
git add api/pyproject.toml api/src/serversherpa/config.py api/tests/conftest.py api/tests/test_spec_lookup_config.py .env.example
git commit -m "feat(spec-lookup): anthropic SDK dependency and SS_ANTHROPIC_* / SS_SPEC_LOOKUP_* settings"
```

(The root `.env` files are untracked — never `git add` them.)

---

### Task 2: Migration 0080, ORM models, model fields in the API

**Files:**
- Create: `api/migrations/versions/0080_spec_lookup.py`
- Modify: `api/src/serversherpa/db/models.py` (`AssetModel` ~line 596; new classes after `AssetModelAlias`)
- Modify: `api/src/serversherpa/api/schemas.py` (`AssetModelItem` 1179, `AssetModelCreateIn` 1205, `AssetModelUpdateIn` 1225)
- Modify: `api/src/serversherpa/api/routes/asset_models.py` (`MODEL_FIELDS`, `_item`)
- Test: `api/tests/test_spec_lookup_schema.py`

**Interfaces:**
- Produces ORM: `AssetModel.private: bool`, `AssetModel.spec_lookup_skip: bool`, `AssetModel.specs_looked_up_at: datetime | None`; `SpecLookupJob`, `SpecSuggestion` (columns below).
- Produces API: `AssetModelItem.private`, `.spec_lookup_skip`, `.specs_looked_up_at`; Create/Update accept `private`, `spec_lookup_skip` (bool).

- [ ] **Step 1: Write the failing test**

`api/tests/test_spec_lookup_schema.py`:

```python
"""0080: model flags, the lookup queue, suggestions; flags round-trip the API."""
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from tests.test_assets_api import login


async def test_model_flags_default_false(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.commit()
    row = await db.scalar(select(AssetModel).where(AssetModel.id == m.id))
    assert row.private is False and row.spec_lookup_skip is False
    assert row.specs_looked_up_at is None


async def test_one_active_job_per_model(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    db.add(SpecLookupJob(model_id=m.id))
    await db.commit()
    db.add(SpecLookupJob(model_id=m.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_done_jobs_do_not_block_a_new_one(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    db.add(SpecLookupJob(model_id=m.id, status="done"))
    db.add(SpecLookupJob(model_id=m.id))
    await db.commit()


async def test_suggestion_defaults(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U rack",
                       source_url="https://www.hpe.com/x")
    db.add(s)
    await db.commit()
    row = await db.scalar(select(SpecSuggestion).where(SpecSuggestion.id == s.id))
    assert row.status == "pending" and row.unit is None and row.previous_value is None


async def test_flags_round_trip_the_api(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs,
                             json={"make": "Acme", "model": "Secret 9000", "private": True})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["private"] is True and body["spec_lookup_skip"] is False
    assert body["specs_looked_up_at"] is None
    resp = await client.patch(f"/asset-models/{body['id']}", headers=hdrs,
                              json={"private": False, "spec_lookup_skip": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["private"] is False and resp.json()["spec_lookup_skip"] is True
```

(If `POST /asset-models` returns 200 rather than 201 in this codebase, match what `tests/test_asset_models_api.py` asserts.)

- [ ] **Step 2: Run it — expect FAIL** (`ImportError: cannot import name 'SpecLookupJob'`)

- [ ] **Step 3: Write the migration**

`api/migrations/versions/0080_spec_lookup.py`:

```python
"""Model spec lookup: model flags, the lookup queue, suggestions.

Revision ID: 0080
Revises: 0073
Create Date: 2026-09-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0080"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("asset_models", sa.Column(
        "private", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("asset_models", sa.Column(
        "spec_lookup_skip", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("asset_models", sa.Column(
        "specs_looked_up_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "spec_lookup_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("priority", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("search_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.Text, nullable=True),
        sa.CheckConstraint("status IN ('queued','running','done','failed')",
                           name="spec_lookup_jobs_status_check"),
    )
    op.create_index("spec_lookup_jobs_one_active", "spec_lookup_jobs", ["model_id"],
                    unique=True, postgresql_where=sa.text("status IN ('queued','running')"))
    op.create_index("spec_lookup_jobs_claim", "spec_lookup_jobs",
                    ["status", "priority", "created_at"])

    op.create_table(
        "spec_suggestions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("job_id", UUID(as_uuid=True),
                  sa.ForeignKey("spec_lookup_jobs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("field", sa.Text, nullable=False),
        sa.Column("value", sa.Text, nullable=False),
        sa.Column("unit", sa.Text, nullable=True),
        sa.Column("source_url", sa.Text, nullable=False),
        sa.Column("quote", sa.Text, nullable=False),
        sa.Column("previous_value", sa.Text, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("decided_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "field IN ('ru_size','weight','length','width','height',"
            "'mount_type','rail_type','knowledge')", name="spec_suggestions_field_check"),
        sa.CheckConstraint(
            "status IN ('pending','applied','approved','rejected','reverted')",
            name="spec_suggestions_status_check"),
        sa.CheckConstraint("unit IS NULL OR unit IN ('lbs','kg','in','cm')",
                           name="spec_suggestions_unit_check"),
    )
    op.create_index("spec_suggestions_model_status", "spec_suggestions", ["model_id", "status"])
    op.create_index("spec_suggestions_status_created", "spec_suggestions",
                    ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("spec_suggestions")
    op.drop_table("spec_lookup_jobs")
    op.drop_column("asset_models", "specs_looked_up_at")
    op.drop_column("asset_models", "spec_lookup_skip")
    op.drop_column("asset_models", "private")
```

- [ ] **Step 4: ORM**

In `AssetModel`, after `review_dismissed_at`:

```python
    private: Mapped[bool] = mapped_column(server_default=text("false"))           # 0080: never sent to Claude
    spec_lookup_skip: Mapped[bool] = mapped_column(server_default=text("false"))  # 0080: junk, don't look up
    specs_looked_up_at: Mapped[datetime | None]                                   # 0080
```

After `class AssetModelAlias`:

```python
class SpecLookupJob(Base):
    """spec-lookup-worker's queue (0080). Same claim shape as
    LabelGenerationRun, plus priority (0 sweep, 10 "Find missing specs",
    20 per-model button) and next_attempt_at for retry backoff. One
    queued/running job per model (partial unique index)."""
    __tablename__ = "spec_lookup_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    model_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("asset_models.id", ondelete="CASCADE"))
    priority: Mapped[int] = mapped_column(Integer, server_default="0")
    status: Mapped[str] = mapped_column(server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    next_attempt_at: Mapped[datetime | None]
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    error: Mapped[str | None]
    input_tokens: Mapped[int] = mapped_column(Integer, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, server_default="0")
    search_count: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    heartbeat_at: Mapped[datetime | None]
    worker_id: Mapped[str | None]


class SpecSuggestion(Base):
    """One value Claude found for one model field (0080). `value` is the
    normalized text ("2", "38.5", "rails"); `previous_value` is the field's
    value, in the same unit, when the suggestion was made — approve/undo
    refuse with field_changed when the model no longer matches."""
    __tablename__ = "spec_suggestions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    model_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("asset_models.id", ondelete="CASCADE"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("spec_lookup_jobs.id", ondelete="SET NULL"))
    field: Mapped[str]
    value: Mapped[str]
    unit: Mapped[str | None]
    source_url: Mapped[str]
    quote: Mapped[str]
    previous_value: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="pending")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    decided_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

(The conftest `TRUNCATE ... asset_models ... CASCADE` already empties both new tables through their FKs — no conftest change needed.)

- [ ] **Step 5: API fields**

`schemas.py` — `AssetModelItem`, after `review_dismissed_at`:

```python
    private: bool = False
    spec_lookup_skip: bool = False
    specs_looked_up_at: datetime | None = None
```

`AssetModelCreateIn`, after `knowledge: str = ""`:

```python
    private: bool = False
    spec_lookup_skip: bool = False
```

`AssetModelUpdateIn`, after `knowledge: str | None = None`:

```python
    private: bool | None = None
    spec_lookup_skip: bool | None = None
```

`routes/asset_models.py` — append `"private", "spec_lookup_skip"` to `MODEL_FIELDS`, and add both to `NON_NULLABLE_MODEL_FIELDS`'s sibling check: in `update_asset_model`, right after the `knowledge_required` check, add

```python
    for flag in ("private", "spec_lookup_skip"):
        if flag in data and data[flag] is None:
            raise _err(422, f"{flag}_required")
```

and in `_item`, after `"review_dismissed_at": m.review_dismissed_at,`:

```python
        "private": m.private, "spec_lookup_skip": m.spec_lookup_skip,
        "specs_looked_up_at": m.specs_looked_up_at,
```

Check how `create_asset_model` builds the row (it may iterate `MODEL_FIELDS` or `body.model_dump()`); make sure `private`/`spec_lookup_skip` reach the `AssetModel(...)` constructor.

- [ ] **Step 6: Run** `tests/test_spec_lookup_schema.py tests/test_asset_models_api.py tests/test_asset_model_merge_api.py -q` — expect PASS. Also run `.venv/bin/alembic downgrade 0073 && .venv/bin/alembic upgrade head` against the test DB (`SS_DATABASE_URL` pointed at `serversherpa_test_spec_lookup`) to prove the downgrade.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0080_spec_lookup.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/asset_models.py api/tests/test_spec_lookup_schema.py
git commit -m "feat(spec-lookup): migration 0080 — model private/skip/looked-up flags, lookup queue, suggestions"
```

---

### Task 3: `ai_lookup` settings section

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (`DEFAULTS`)
- Modify: `api/src/serversherpa/api/schemas.py` (after `SecurityConfigIn`)
- Modify: `api/src/serversherpa/api/routes/system.py` (after `put_security_config`)
- Test: `api/tests/test_ai_lookup_config_api.py`

**Interfaces:**
- Produces: `read_section(db, "ai_lookup") -> {"background_enabled": bool, "auto_apply": bool, "fields_specs": bool, "fields_mounting": bool, "fields_knowledge": bool, "retry_after_days": int}`; `GET/PUT /system/ai-lookup`.

- [ ] **Step 1: Failing test**

```python
"""System settings › AI lookup: defaults, partial PUT, audit, permissions."""
from sqlalchemy import select

from serversherpa.db.models import AuditLog
from tests.test_assets_api import login
from tests.test_system_api import _super_admin_headers

DEFAULTS = {"background_enabled": False, "auto_apply": False, "fields_specs": True,
            "fields_mounting": False, "fields_knowledge": False, "retry_after_days": 90}


async def test_defaults(client, db, seeded_user):
    hdrs = await login(client)                      # staff: settings view
    resp = await client.get("/system/ai-lookup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == DEFAULTS


async def test_staff_cannot_change(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.put("/system/ai-lookup", headers=hdrs, json={"auto_apply": True})
    assert resp.status_code == 403


async def test_partial_put_and_audit(client, db, seeded_user):
    hdrs = await _super_admin_headers(db, client)
    resp = await client.put("/system/ai-lookup", headers=hdrs,
                            json={"background_enabled": True, "retry_after_days": 30})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {**DEFAULTS, "background_enabled": True, "retry_after_days": 30}
    assert (await client.get("/system/ai-lookup", headers=hdrs)).json()["retry_after_days"] == 30
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "ai_lookup_config_update"))
    assert row.changes["background_enabled"] == {"from": False, "to": True}


async def test_rejects_bad_values(client, db, seeded_user):
    hdrs = await _super_admin_headers(db, client)
    assert (await client.put("/system/ai-lookup", headers=hdrs,
                             json={"retry_after_days": -1})).status_code == 422
    assert (await client.put("/system/ai-lookup", headers=hdrs,
                             json={"nope": True})).status_code == 422
```

(Confirm `_super_admin_headers(db, client)` exists in `tests/test_system_api.py` with that signature — `tests/test_env_api.py` imports it.)

- [ ] **Step 2: Run — expect FAIL (404).**

- [ ] **Step 3: Implement**

`config_store.py` `DEFAULTS`, new entry after `"security"`:

```python
    # Makes / Models spec lookup (Claude). Field groups decide what the
    # worker asks for; auto_apply fills BLANK fields only (never knowledge).
    "ai_lookup": {
        "background_enabled": False,
        "auto_apply": False,
        "fields_specs": True,
        "fields_mounting": False,
        "fields_knowledge": False,
        "retry_after_days": 90,
    },
```

`schemas.py`, after `SecurityConfigIn`:

```python
class AiLookupConfigOut(BaseModel):
    background_enabled: bool
    auto_apply: bool
    fields_specs: bool
    fields_mounting: bool
    fields_knowledge: bool
    retry_after_days: int


class AiLookupConfigIn(BaseModel):
    """Partial update — only sent fields change. retry_after_days 0 = never
    retry a looked-up model automatically."""

    model_config = ConfigDict(extra="forbid")

    background_enabled: bool | None = None
    auto_apply: bool | None = None
    fields_specs: bool | None = None
    fields_mounting: bool | None = None
    fields_knowledge: bool | None = None
    retry_after_days: int | None = Field(default=None, ge=0, le=3650)
```

`system.py` — import both schemas, then after `put_security_config`:

```python
AI_LOOKUP_SECTION = "ai_lookup"


@router.get("/ai-lookup", response_model=AiLookupConfigOut)
async def get_ai_lookup_config(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "view"),
) -> AiLookupConfigOut:
    return AiLookupConfigOut(**await read_section(db, AI_LOOKUP_SECTION))


@router.put("/ai-lookup", response_model=AiLookupConfigOut)
async def put_ai_lookup_config(
    body: AiLookupConfigIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AiLookupConfigOut:
    stored = await read_section(db, AI_LOOKUP_SECTION)
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items()
             if v is not None}
    data = {**stored, **patch}
    row = await db.get(SystemConfig, AI_LOOKUP_SECTION)
    if row is None:
        row = SystemConfig(section=AI_LOOKUP_SECTION)
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": data[key]}
               for key in data if stored.get(key) != data[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id=AI_LOOKUP_SECTION, action="ai_lookup_config_update",
              changes=changes)
    await db.commit()
    return AiLookupConfigOut(**data)
```

- [ ] **Step 4: Run — expect PASS.** Also `tests/test_system_api.py -q`.
- [ ] **Step 5: Commit** — `git commit -m "feat(spec-lookup): System settings ai_lookup section (GET/PUT /system/ai-lookup)"`

---

### Task 4: Field map + verifier (pure)

**Files:**
- Create: `api/src/serversherpa/spec_lookup/__init__.py` (one-line docstring)
- Create: `api/src/serversherpa/spec_lookup/fields.py`
- Create: `api/src/serversherpa/spec_lookup/verify.py`
- Test: `api/tests/test_spec_lookup_fields.py`, `api/tests/test_spec_lookup_verify.py`

**Interfaces:**
- Produces (`fields.py`):
  - `ALL_FIELDS: tuple[str, ...]` = `("ru_size","weight","length","width","height","mount_type","rail_type","knowledge")`
  - `enabled_fields(cfg: dict) -> list[str]`
  - `is_blank(m: AssetModel, field: str) -> bool`
  - `wanted_fields(m: AssetModel, cfg: dict) -> list[str]` (enabled AND blank)
  - `current_value(m: AssetModel, field: str, unit: str | None) -> str | None` (normalized text in that unit)
  - `column_payload(field: str, value: str | None, unit: str | None) -> dict` (column → python value, before `apply_unit_pairs`)
  - `blank_conditions(fields: list[str]) -> list` (SQLAlchemy boolean clauses)
  - `normalize_number(x: float, field: str) -> str`
- Produces (`verify.py`): `verify_finding(field, value, unit, quote, source_url, seen_urls) -> Verified | None` where `@dataclass(frozen=True) class Verified: field: str; value: str; unit: str | None; quote: str; source_url: str`; `normalize_url(url: str) -> str`; `numbers_in(text: str) -> list[float]`.

- [ ] **Step 1: Failing tests**

`api/tests/test_spec_lookup_fields.py`:

```python
from decimal import Decimal

from serversherpa.db.models import AssetModel
from serversherpa.spec_lookup.fields import (
    column_payload, current_value, enabled_fields, is_blank, wanted_fields,
)

CFG = {"fields_specs": True, "fields_mounting": False, "fields_knowledge": False}


def _m(**kw):
    base = dict(make="HPE", model="DL320", knowledge="")
    base.update(kw)
    return AssetModel(**base)


def test_enabled_fields_follow_groups():
    assert enabled_fields(CFG) == ["ru_size", "weight", "length", "width", "height"]
    assert enabled_fields({**CFG, "fields_specs": False, "fields_knowledge": True}) == ["knowledge"]
    assert enabled_fields({**CFG, "fields_mounting": True})[-2:] == ["mount_type", "rail_type"]


def test_blank_rules():
    m = _m(ru_size=1, weight_lbs=Decimal("30.50"), weight_kg=Decimal("13.83"))
    assert not is_blank(m, "ru_size") and not is_blank(m, "weight")
    assert is_blank(m, "length") and is_blank(m, "knowledge")
    assert not is_blank(_m(knowledge="tip"), "knowledge")


def test_wanted_is_enabled_and_blank():
    m = _m(ru_size=1)
    assert wanted_fields(m, CFG) == ["weight", "length", "width", "height"]


def test_current_value_in_unit():
    m = _m(weight_lbs=Decimal("30.50"), weight_kg=Decimal("13.83"), ru_size=2)
    assert current_value(m, "weight", "lbs") == "30.5"
    assert current_value(m, "weight", "kg") == "13.83"
    assert current_value(m, "ru_size", None) == "2"
    assert current_value(m, "length", "in") is None
    assert current_value(_m(), "knowledge", None) is None


def test_column_payload():
    assert column_payload("ru_size", "2", None) == {"ru_size": 2}
    assert column_payload("weight", "13.6", "kg") == {"weight_kg": 13.6}
    assert column_payload("height", "1.7", "in") == {"height_in": 1.7}
    assert column_payload("height", None, "in") == {"height_in": None}
    assert column_payload("mount_type", "rails", None) == {"mount_type": "rails"}
    assert column_payload("knowledge", "1U server.", None) == {"knowledge": "1U server."}
    assert column_payload("knowledge", None, None) == {"knowledge": ""}
```

`api/tests/test_spec_lookup_verify.py`:

```python
from serversherpa.spec_lookup.verify import numbers_in, normalize_url, verify_finding

SEEN = {normalize_url("https://www.hpe.com/psnow/doc/a50004307enw")}
URL = "https://www.hpe.com/psnow/doc/a50004307enw/"


def v(field, value, unit, quote, url=URL):
    return verify_finding(field, value, unit, quote, url, SEEN)


def test_numbers_in():
    assert numbers_in("Weight: 1,234.5 lb") == [1234.5]
    assert numbers_in("43.46 x 70.7 x 4.29 cm") == [43.46, 70.7, 4.29]
    assert numbers_in("17,5 kg") == [17.5]
    assert numbers_in("2U") == [2.0]


def test_url_normalization():
    assert normalize_url("https://WWW.hpe.com/a/?x=1#frag") == "https://www.hpe.com/a?x=1"


def test_accepts_value_present_in_quote():
    got = v("weight", "13.6", "kg", "Maximum weight 13.6 kg (30 lb)")
    assert got is not None and got.value == "13.6" and got.unit == "kg"
    assert v("ru_size", "1", None, "1U rack height").value == "1"


def test_rejects_value_missing_from_quote():
    assert v("weight", "14", "kg", "Maximum weight 13.6 kg") is None


def test_rejects_unseen_url():
    assert v("ru_size", "1", None, "1U", url="https://example.com/made-up") is None


def test_bounds():
    assert v("ru_size", "0", None, "0U") is None
    assert v("ru_size", "61", None, "61U") is None
    assert v("weight", "4000", "lbs", "4000 lbs") is None
    assert v("height", "200", "in", "200 in") is None
    assert v("height", "4.29", "cm", "4.29 cm") is not None


def test_units_must_fit_the_field():
    assert v("weight", "13.6", "cm", "13.6 cm") is None
    assert v("ru_size", "1", "in", "1U") is None


def test_mount_and_rail_and_knowledge():
    assert v("mount_type", "rails", None, "ships with sliding rails").value == "rails"
    assert v("mount_type", "magnets", None, "magnets") is None
    assert v("rail_type", "Easy install sliding rails", None, "Easy install sliding rails") is not None
    assert v("rail_type", "x" * 101, None, "x") is None
    assert v("knowledge", "1U, 2-socket server.", None, "The DL320 is a 1U server") is not None
    assert v("knowledge", "y" * 1001, None, "y") is None


def test_empty_quote_rejected():
    assert v("ru_size", "1", None, "   ") is None
```

- [ ] **Step 2: Run both — expect FAIL (ModuleNotFoundError).**

- [ ] **Step 3: Implement `fields.py`**

```python
"""Spec lookup fields ↔ asset_models columns. A "field" is what Claude is
asked for (weight, length, ...); unit-paired fields map to both columns and
count as blank only when both are empty."""

from decimal import Decimal

from serversherpa.db.models import AssetModel

GROUPS: dict[str, tuple[str, ...]] = {
    "fields_specs": ("ru_size", "weight", "length", "width", "height"),
    "fields_mounting": ("mount_type", "rail_type"),
    "fields_knowledge": ("knowledge",),
}
ALL_FIELDS: tuple[str, ...] = tuple(f for g in GROUPS.values() for f in g)

# field -> {unit: column}; unitless fields use the None key
COLUMNS: dict[str, dict[str | None, str]] = {
    "ru_size": {None: "ru_size"},
    "weight": {"lbs": "weight_lbs", "kg": "weight_kg"},
    "length": {"in": "length_in", "cm": "length_cm"},
    "width": {"in": "width_in", "cm": "width_cm"},
    "height": {"in": "height_in", "cm": "height_cm"},
    "mount_type": {None: "mount_type"},
    "rail_type": {None: "rail_type"},
    "knowledge": {None: "knowledge"},
}
NUMERIC = ("ru_size", "weight", "length", "width", "height")


def enabled_fields(cfg: dict) -> list[str]:
    return [f for key, group in GROUPS.items() if cfg.get(key) for f in group]


def _empty(v) -> bool:
    return v is None or v == ""


def is_blank(m: AssetModel, field: str) -> bool:
    return all(_empty(getattr(m, col)) for col in COLUMNS[field].values())


def wanted_fields(m: AssetModel, cfg: dict) -> list[str]:
    return [f for f in enabled_fields(cfg) if is_blank(m, f)]


def normalize_number(x: float, field: str) -> str:
    if field == "ru_size":
        return str(int(round(x)))
    return f"{round(float(x), 2):g}"


def current_value(m: AssetModel, field: str, unit: str | None) -> str | None:
    col = COLUMNS[field].get(unit) or next(iter(COLUMNS[field].values()))
    v = getattr(m, col)
    if _empty(v):
        return None
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return normalize_number(float(v), field)
    return str(v)


def column_payload(field: str, value: str | None, unit: str | None) -> dict:
    col = COLUMNS[field].get(unit) or next(iter(COLUMNS[field].values()))
    if value is None:
        return {col: "" if field == "knowledge" else None}
    if field == "ru_size":
        return {col: int(float(value))}
    if field in NUMERIC:
        return {col: float(value)}
    return {col: value}


def blank_conditions(fields: list[str]) -> list:
    """One SQL clause per field: true when that field is blank."""
    from sqlalchemy import and_

    out = []
    for f in fields:
        cols = [getattr(AssetModel, c) for c in COLUMNS[f].values()]
        if f == "knowledge":
            out.append(AssetModel.knowledge == "")
        else:
            out.append(and_(*[c.is_(None) for c in cols]))
    return out
```

- [ ] **Step 4: Implement `verify.py`**

```python
"""Code-side checks on what Claude returned. The model is never trusted to
be right: a value survives only if its quote contains it, it is inside sane
bounds, and its source URL was really searched or fetched in that call."""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from serversherpa.spec_lookup.fields import NUMERIC, normalize_number

MOUNT_TYPES = ("rails", "ears", "shelf", "custom")
UNITS = {"ru_size": {None}, "weight": {"lbs", "kg"}, "length": {"in", "cm"},
         "width": {"in", "cm"}, "height": {"in", "cm"},
         "mount_type": {None}, "rail_type": {None}, "knowledge": {None}}
BOUNDS = {("ru_size", None): (1, 60), ("weight", "lbs"): (0.1, 3000),
          ("weight", "kg"): (0.05, 1361)}
for _dim in ("length", "width", "height"):
    BOUNDS[(_dim, "in")] = (0.5, 120)
    BOUNDS[(_dim, "cm")] = (1, 305)
MAX_TEXT = {"rail_type": 100, "knowledge": 1000}

_NUM = re.compile(r"\d+(?:[.,]\d+)*")


@dataclass(frozen=True)
class Verified:
    field: str
    value: str
    unit: str | None
    quote: str
    source_url: str


def _to_float(token: str) -> float:
    if "," in token and "." in token:
        return float(token.replace(",", ""))
    if "," in token:
        head, _, tail = token.rpartition(",")
        # "1,234" is thousands; "17,5" is a decimal comma
        return float(token.replace(",", "")) if len(tail) == 3 else float(f"{head}.{tail}")
    return float(token)


def numbers_in(text: str) -> list[float]:
    return [_to_float(t) for t in _NUM.findall(text)]


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def verify_finding(field: str, value: str, unit: str | None, quote: str,
                   source_url: str, seen_urls: set[str]) -> Verified | None:
    quote = (quote or "").strip()
    value = (value or "").strip()
    if field not in UNITS or unit not in UNITS[field] or not quote or not value:
        return None
    if normalize_url(source_url) not in seen_urls:
        return None
    if field in NUMERIC:
        try:
            x = float(value.replace(",", ""))
        except ValueError:
            return None
        lo, hi = BOUNDS[(field, unit)]
        if not lo <= x <= hi:
            return None
        if not any(abs(n - x) < 0.011 for n in numbers_in(quote)):
            return None
        return Verified(field, normalize_number(x, field), unit, quote, source_url)
    if field == "mount_type":
        v = value.lower()
        if v not in MOUNT_TYPES:
            return None
        return Verified(field, v, None, quote, source_url)
    if len(value) > MAX_TEXT[field]:
        return None
    return Verified(field, value, None, quote, source_url)
```

- [ ] **Step 5: Run both — expect PASS.**
- [ ] **Step 6: Commit** — `git commit -m "feat(spec-lookup): field map and value verifier"`

---

### Task 5: Claude provider

**Files:**
- Create: `api/src/serversherpa/spec_lookup/provider.py`
- Test: `api/tests/test_spec_lookup_provider.py`

**Interfaces:**
- Consumes: `Settings.anthropic_api_key`, `.spec_lookup_model`, `.spec_lookup_max_searches`, `.spec_lookup_max_fetches`; `normalize_url` (Task 4).
- Produces:
  - `@dataclass class Finding: field: str; value: str; unit: str | None; quote: str; source_url: str`
  - `@dataclass class LookupResult: findings: list[Finding]; seen_urls: set[str]; input_tokens: int; output_tokens: int; search_count: int`
  - Exceptions `ProviderNotConfigured`, `ProviderRetryable`, `ProviderFailed` (all subclass `ProviderError(Exception)`; message = short reason code/text)
  - `class LookupProvider(Protocol)`: `async def lookup(self, *, make: str, model: str, aliases: list[str], category: str | None, fields: list[str]) -> LookupResult`; `async def ping(self) -> None`; `async def aclose(self) -> None`
  - `class ClaudeProvider(LookupProvider)`: `__init__(self, *, api_key: str, model: str, max_searches: int, max_fetches: int, client=None)`
  - `get_provider() -> LookupProvider | None` (None when the key is empty)
  - `SEARCH_COST_USD = 0.01`, `INPUT_COST_PER_MTOK = 2.0`, `OUTPUT_COST_PER_MTOK = 10.0`, `estimate_cost(input_tokens, output_tokens, searches) -> float`

The provider works on `response.model_dump()` dicts so tests can feed plain dicts; the continuation after `pause_turn` passes the original `response.content` back.

- [ ] **Step 1: Failing test**

```python
"""ClaudeProvider against a fake AsyncAnthropic: request shape, pause_turn
continuation, URL harvesting, usage, error mapping. No network."""
import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from serversherpa.spec_lookup.provider import (
    ClaudeProvider, ProviderFailed, ProviderNotConfigured, ProviderRetryable,
    estimate_cost, get_provider,
)


class Resp:
    def __init__(self, content, stop_reason="end_turn", searches=0, inp=100, out=20):
        self.content = content
        self._d = {"content": content, "stop_reason": stop_reason,
                   "usage": {"input_tokens": inp, "output_tokens": out,
                             "server_tool_use": {"web_search_requests": searches}}}

    def model_dump(self, **_):
        return self._d


class FakeMessages:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def fake_client(responses):
    return SimpleNamespace(messages=FakeMessages(responses), close=lambda: None)


SEARCH = {"type": "web_search_tool_result", "tool_use_id": "s1",
          "content": [{"type": "web_search_result", "url": "https://www.hpe.com/a/",
                       "title": "DL320"}]}
FETCH = {"type": "web_fetch_tool_result", "tool_use_id": "f1",
         "content": {"type": "web_fetch_result", "url": "https://www.hpe.com/spec.pdf",
                     "content": {}}}
ANSWER = {"findings": [{"field": "ru_size", "value": "1", "unit": "none",
                        "quote": "1U", "source_url": "https://www.hpe.com/a"}], "notes": ""}


def prov(client):
    return ClaudeProvider(api_key="k", model="claude-sonnet-5", max_searches=4,
                          max_fetches=3, client=client)


async def test_lookup_parses_and_harvests_urls():
    c = fake_client([Resp([SEARCH, FETCH, {"type": "text", "text": json.dumps(ANSWER)}],
                          searches=2)])
    r = await prov(c).lookup(make="HPE", model="DL320 Gen11", aliases=["DL320"],
                             category="server", fields=["ru_size", "weight"])
    assert [(f.field, f.value, f.unit) for f in r.findings] == [("ru_size", "1", None)]
    assert r.seen_urls == {"https://www.hpe.com/a", "https://www.hpe.com/spec.pdf"}
    assert (r.input_tokens, r.output_tokens, r.search_count) == (100, 20, 2)
    call = c.messages.calls[0]
    assert call["model"] == "claude-sonnet-5"
    assert {t["type"] for t in call["tools"]} == {"web_search_20260209", "web_fetch_20260209"}
    assert call["tools"][0]["max_uses"] == 4
    prompt = call["messages"][0]["content"]
    assert "DL320 Gen11" in prompt and "ru_size" in prompt and "weight" in prompt
    assert call["output_config"]["format"]["type"] == "json_schema"


async def test_pause_turn_continues_and_sums_usage():
    first = Resp([SEARCH], stop_reason="pause_turn", searches=1)
    second = Resp([{"type": "text", "text": json.dumps(ANSWER)}], searches=1)
    c = fake_client([first, second])
    r = await prov(c).lookup(make="HPE", model="DL320", aliases=[], category=None,
                             fields=["ru_size"])
    assert len(c.messages.calls) == 2
    assert c.messages.calls[1]["messages"][1] == {"role": "assistant", "content": first.content}
    assert r.search_count == 2 and r.input_tokens == 200
    assert "https://www.hpe.com/a" in r.seen_urls


async def test_refusal_and_bad_json_fail():
    with pytest.raises(ProviderFailed, match="refusal"):
        await prov(fake_client([Resp([], stop_reason="refusal")])).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])
    with pytest.raises(ProviderFailed, match="bad_output"):
        await prov(fake_client([Resp([{"type": "text", "text": "not json"}])])).lookup(
            make="a", model="b", aliases=[], category=None, fields=["ru_size"])


def _status_error(cls, code):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("boom", response=httpx.Response(code, request=req), body=None)


async def test_error_mapping():
    async def run(exc):
        await prov(fake_client([exc])).lookup(make="a", model="b", aliases=[],
                                              category=None, fields=["ru_size"])
    with pytest.raises(ProviderNotConfigured):
        await run(_status_error(anthropic.AuthenticationError, 401))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.RateLimitError, 429))
    with pytest.raises(ProviderRetryable):
        await run(_status_error(anthropic.InternalServerError, 500))
    with pytest.raises(ProviderRetryable):
        await run(anthropic.APIConnectionError(
            request=httpx.Request("POST", "https://api.anthropic.com")))
    with pytest.raises(ProviderFailed):
        await run(_status_error(anthropic.BadRequestError, 400))


def test_get_provider_none_without_key():
    assert get_provider() is None


def test_estimate_cost():
    assert estimate_cost(1_000_000, 100_000, 10) == pytest.approx(2.0 + 1.0 + 0.10)
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `provider.py`**

```python
"""The only code that talks to Claude. One Messages call per model with the
server-side web_search + web_fetch tools and a JSON-schema answer; the caller
(worker) verifies every value before anything is stored. Only make, model,
aliases, category and the wanted field names are sent."""

import json
import logging
import time
from dataclasses import dataclass, field as dc_field
from typing import Protocol

import anthropic

from serversherpa.spec_lookup.fields import ALL_FIELDS
from serversherpa.spec_lookup.verify import normalize_url

logger = logging.getLogger("serversherpa.spec_lookup.provider")

MAX_CONTINUATIONS = 3
MAX_TOKENS = 4000
SEARCH_COST_USD = 0.01                 # $10 per 1,000 searches
INPUT_COST_PER_MTOK = 2.0              # claude-sonnet-5
OUTPUT_COST_PER_MTOK = 10.0


def estimate_cost(input_tokens: int, output_tokens: int, searches: int) -> float:
    return (input_tokens / 1e6 * INPUT_COST_PER_MTOK
            + output_tokens / 1e6 * OUTPUT_COST_PER_MTOK
            + searches * SEARCH_COST_USD)


class ProviderError(Exception):
    pass


class ProviderNotConfigured(ProviderError):
    pass


class ProviderRetryable(ProviderError):
    pass


class ProviderFailed(ProviderError):
    pass


@dataclass
class Finding:
    field: str
    value: str
    unit: str | None
    quote: str
    source_url: str


@dataclass
class LookupResult:
    findings: list[Finding] = dc_field(default_factory=list)
    seen_urls: set[str] = dc_field(default_factory=set)
    input_tokens: int = 0
    output_tokens: int = 0
    search_count: int = 0


class LookupProvider(Protocol):
    async def lookup(self, *, make: str, model: str, aliases: list[str],
                     category: str | None, fields: list[str]) -> LookupResult: ...
    async def ping(self) -> None: ...
    async def aclose(self) -> None: ...


FIELD_HELP = {
    "ru_size": "rack units the unit occupies (integer, e.g. 2 for a 2U server); unit 'none'",
    "weight": "maximum/fully configured weight; unit 'lbs' or 'kg' as printed",
    "length": "depth front-to-back; unit 'in' or 'cm' as printed",
    "width": "width; unit 'in' or 'cm' as printed",
    "height": "height; unit 'in' or 'cm' as printed",
    "mount_type": "one of rails, ears, shelf, custom; unit 'none'",
    "rail_type": "the rail kit's name or kind, short; unit 'none'",
    "knowledge": "one or two plain sentences on what the product is; unit 'none'",
}

SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": list(ALL_FIELDS)},
                    "value": {"type": "string"},
                    "unit": {"type": "string", "enum": ["lbs", "kg", "in", "cm", "none"]},
                    "quote": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["field", "value", "unit", "quote", "source_url"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["findings", "notes"],
    "additionalProperties": False,
}

SYSTEM = (
    "You look up physical specifications of datacenter hardware for an asset "
    "catalog. Use web search and web fetch; prefer the manufacturer's own spec "
    "sheets and product pages, then reputable resellers. Never answer from "
    "memory: every value must come from a page you searched or fetched in this "
    "conversation, and `quote` must be the exact text from that page that "
    "states it (copied, not paraphrased), with `source_url` the page's URL. "
    "Match the exact model and variant; if a page covers a different variant, "
    "leave the value out. Omit any field you could not find — an empty "
    "findings list is a fine answer."
)


def _prompt(make: str, model: str, aliases: list[str], category: str | None,
            fields: list[str]) -> str:
    lines = [f"Make: {make}", f"Model: {model}"]
    if aliases:
        lines.append("Also known as: " + ", ".join(aliases))
    if category:
        lines.append(f"Category: {category}")
    lines.append("Find these fields:")
    lines += [f"- {f}: {FIELD_HELP[f]}" for f in fields]
    return "\n".join(lines)


def _harvest(d: dict, seen: set[str]) -> None:
    for block in d.get("content") or []:
        kind = block.get("type")
        content = block.get("content")
        if kind == "web_search_tool_result" and isinstance(content, list):
            for r in content:
                if r.get("url"):
                    seen.add(normalize_url(r["url"]))
        elif kind == "web_fetch_tool_result" and isinstance(content, dict):
            if content.get("url"):
                seen.add(normalize_url(content["url"]))


class ClaudeProvider:
    def __init__(self, *, api_key: str, model: str, max_searches: int,
                 max_fetches: int, client=None) -> None:
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, max_retries=0)
        self._model = model
        self._max_searches = max_searches
        self._max_fetches = max_fetches

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            res = close()
            if hasattr(res, "__await__"):
                await res

    async def _create(self, **kw):
        try:
            return await self._client.messages.create(**kw)
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            raise ProviderNotConfigured("not_configured") from exc
        except (anthropic.RateLimitError, anthropic.InternalServerError,
                anthropic.APIConnectionError) as exc:      # APITimeoutError is a subclass
            raise ProviderRetryable(type(exc).__name__) from exc
        except anthropic.APIStatusError as exc:
            raise ProviderFailed(f"api_error {exc.status_code}: {exc}"[:500]) from exc

    async def lookup(self, *, make: str, model: str, aliases: list[str],
                     category: str | None, fields: list[str]) -> LookupResult:
        user = {"role": "user", "content": _prompt(make, model, aliases, category, fields)}
        messages: list[dict] = [user]
        result = LookupResult()
        text = None
        for _ in range(MAX_CONTINUATIONS + 1):
            resp = await self._create(
                model=self._model, max_tokens=MAX_TOKENS, system=SYSTEM,
                messages=messages,
                tools=[
                    {"type": "web_search_20260209", "name": "web_search",
                     "max_uses": self._max_searches},
                    {"type": "web_fetch_20260209", "name": "web_fetch",
                     "max_uses": self._max_fetches},
                ],
                output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
            )
            d = resp.model_dump()
            usage = d.get("usage") or {}
            result.input_tokens += usage.get("input_tokens") or 0
            result.output_tokens += usage.get("output_tokens") or 0
            result.search_count += ((usage.get("server_tool_use") or {})
                                    .get("web_search_requests") or 0)
            _harvest(d, result.seen_urls)
            stop = d.get("stop_reason")
            if stop == "refusal":
                raise ProviderFailed("refusal")
            if stop == "pause_turn":
                messages = [user, {"role": "assistant", "content": resp.content}]
                continue
            texts = [b.get("text") for b in d.get("content") or []
                     if b.get("type") == "text" and b.get("text")]
            text = texts[-1] if texts else None
            break
        if text is None:
            raise ProviderFailed("bad_output: no answer")
        try:
            payload = json.loads(text)
            items = payload["findings"]
            result.findings = [
                Finding(field=i["field"], value=str(i["value"]),
                        unit=None if i["unit"] == "none" else i["unit"],
                        quote=i["quote"], source_url=i["source_url"])
                for i in items if i["field"] in fields]
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderFailed(f"bad_output: {exc}"[:500]) from exc
        return result

    async def ping(self) -> None:
        await self._create(model=self._model, max_tokens=16,
                           messages=[{"role": "user", "content": "Reply with: ok"}])


def get_provider() -> LookupProvider | None:
    from serversherpa.config import get_settings

    s = get_settings()
    key = s.anthropic_api_key.get_secret_value()
    if not key:
        return None
    return ClaudeProvider(api_key=key, model=s.spec_lookup_model,
                          max_searches=s.spec_lookup_max_searches,
                          max_fetches=s.spec_lookup_max_fetches)


def is_configured() -> bool:
    from serversherpa.config import get_settings

    return bool(get_settings().anthropic_api_key.get_secret_value())
```

(Unused import `time`/`logger` should be removed if the linter complains; keep the module clean.)

- [ ] **Step 4: Run — expect PASS.** If `anthropic.RateLimitError(...)` construction differs in the installed SDK version, adjust only the test helper `_status_error` to that version's constructor (check `anthropic/_exceptions.py`).
- [ ] **Step 5: Commit** — `git commit -m "feat(spec-lookup): Claude provider (web search + fetch, JSON answer, error mapping)"`

---

### Task 6: Service — eligibility, enqueue, record, approve/reject/undo

**Files:**
- Create: `api/src/serversherpa/spec_lookup/service.py`
- Test: `api/tests/test_spec_lookup_service.py`

**Interfaces:**
- Consumes: Task 2 ORM, Task 3 `read_section(db, "ai_lookup")`, Task 4 fields/verify, Task 5 `LookupResult`/`Finding`, `apply_unit_pairs`, `audit/diff/snapshot`.
- Produces:
  - `AI_LOOKUP = "ai_lookup"`; `PRIORITY_SWEEP = 0`, `PRIORITY_BATCH = 10`, `PRIORITY_MODEL = 20`
  - `class FieldChanged(Exception)`, `class BadState(Exception)`
  - `async def eligible_model_ids(db, cfg: dict, *, respect_retry: bool = True, now: datetime | None = None) -> list[uuid.UUID]`
  - `async def enqueue(db, model_ids: list[uuid.UUID], priority: int, requested_by: uuid.UUID | None) -> int` (rows newly queued; raises priority of an existing queued job; does not commit)
  - `async def record_result(db, job: SpecLookupJob, m: AssetModel, result: LookupResult, cfg: dict) -> list[SpecSuggestion]` (does not commit)
  - `async def approve(db, s: SpecSuggestion, actor_id: uuid.UUID) -> None`, `async def reject(db, s, actor_id) -> None`, `async def undo(db, s, actor_id) -> None` (none commit)
  - audit actions: `spec_lookup.apply` (auto or approve), `spec_lookup.undo`

- [ ] **Step 1: Failing test**

```python
"""Spec lookup service: eligibility, enqueue, record (verify + supersede +
auto-apply), approve / reject / undo."""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import AssetModel, AuditLog, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.provider import Finding, LookupResult

CFG = {"background_enabled": True, "auto_apply": False, "fields_specs": True,
       "fields_mounting": False, "fields_knowledge": False, "retry_after_days": 90}
URL = "https://www.hpe.com/a"


async def _m(db, **kw):
    m = AssetModel(make=kw.pop("make", "HPE"), model=kw.pop("model", "DL320"), **kw)
    db.add(m)
    await db.commit()
    return m


def _result(*findings):
    return LookupResult(findings=list(findings), seen_urls={URL},
                        input_tokens=1000, output_tokens=100, search_count=2)


async def test_eligibility_rules(db):
    now = datetime.now(UTC)
    blank = await _m(db, model="blank")
    full = await _m(db, model="full", ru_size=1, weight_lbs=1, weight_kg=0.45,
                    length_in=1, length_cm=2.54, width_in=1, width_cm=2.54,
                    height_in=1, height_cm=2.54)
    private = await _m(db, model="private", private=True)
    skipped = await _m(db, model="skipped", spec_lookup_skip=True)
    recent = await _m(db, model="recent", specs_looked_up_at=now - timedelta(days=5))
    old = await _m(db, model="old", specs_looked_up_at=now - timedelta(days=100))
    queued = await _m(db, model="queued")
    db.add(SpecLookupJob(model_id=queued.id))
    await db.commit()
    ids = set(await service.eligible_model_ids(db, CFG, now=now))
    assert ids == {blank.id, old.id}
    assert full.id not in ids and private.id not in ids and skipped.id not in ids
    ids = set(await service.eligible_model_ids(db, CFG, respect_retry=False, now=now))
    assert recent.id in ids
    ids = set(await service.eligible_model_ids(db, {**CFG, "retry_after_days": 0}, now=now))
    assert old.id not in ids


async def test_eligibility_follows_field_groups(db):
    m = await _m(db, ru_size=1, weight_lbs=1, weight_kg=0.45, length_in=1, length_cm=2.54,
                 width_in=1, width_cm=2.54, height_in=1, height_cm=2.54)
    assert await service.eligible_model_ids(db, CFG) == []
    assert await service.eligible_model_ids(db, {**CFG, "fields_mounting": True}) == [m.id]


async def test_enqueue_dedupes_and_bumps_priority(db):
    m = await _m(db)
    assert await service.enqueue(db, [m.id], service.PRIORITY_SWEEP, None) == 1
    await db.commit()
    assert await service.enqueue(db, [m.id], service.PRIORITY_MODEL, None) == 0
    await db.commit()
    jobs = (await db.scalars(select(SpecLookupJob))).all()
    assert len(jobs) == 1 and jobs[0].priority == service.PRIORITY_MODEL


async def test_record_verifies_and_sets_looked_up(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("ru_size", "1", None, "1U rack", URL),
        Finding("weight", "30", "lbs", "weighs 13.6 kg", URL),          # not in quote
        Finding("height", "1.7", "in", "1.7 in", "https://elsewhere.example/x"),  # unseen
    ), CFG)
    await db.commit()
    assert [(r.field, r.value, r.status) for r in rows] == [("ru_size", "1", "pending")]
    assert m.specs_looked_up_at is not None and m.ru_size is None
    assert (job.input_tokens, job.output_tokens, job.search_count) == (1000, 100, 2)


async def test_record_supersedes_older_pending(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    first = (await service.record_result(db, job, m, _result(
        Finding("ru_size", "2", None, "2U", URL)), CFG))[0]
    await service.record_result(db, job, m, _result(Finding("ru_size", "1", None, "1U", URL)), CFG)
    await db.commit()
    assert (await db.get(SpecSuggestion, first.id)).status == "rejected"


async def test_auto_apply_fills_blank_only_with_unit_pair_and_audit(db):
    m = await _m(db, ru_size=2)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("ru_size", "1", None, "1U", URL),
        Finding("weight", "13.6", "kg", "13.6 kg", URL),
    ), {**CFG, "auto_apply": True})
    await db.commit()
    by = {r.field: r for r in rows}
    assert by["ru_size"].status == "pending" and m.ru_size == 2      # not blank -> not applied
    assert by["weight"].status == "applied"
    assert float(m.weight_kg) == 13.6 and float(m.weight_lbs) == 29.98
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "spec_lookup.apply"))
    assert row.actor_person_id is None and "weight_kg" in row.changes


async def test_knowledge_never_auto_applies(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("knowledge", "A 1U server.", None, "The DL320 is a 1U server", URL)),
        {**CFG, "auto_apply": True, "fields_knowledge": True})
    assert rows[0].status == "pending" and m.knowledge == ""


async def test_approve_reject_undo(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="height", value="1.7", unit="in",
                       quote="1.7 in", source_url=URL, previous_value=None)
    db.add(s)
    await db.commit()
    await service.approve(db, s, seeded_user.id)
    await db.commit()
    assert s.status == "approved" and float(m.height_in) == 1.7 and float(m.height_cm) == 4.32
    await service.undo(db, s, seeded_user.id)
    await db.commit()
    assert s.status == "reverted" and m.height_in is None and m.height_cm is None
    with pytest.raises(service.BadState):
        await service.reject(db, s, seeded_user.id)


async def test_approve_refuses_when_field_changed(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U",
                       source_url=URL, previous_value=None)
    db.add(s)
    m.ru_size = 4
    await db.commit()
    with pytest.raises(service.FieldChanged):
        await service.approve(db, s, seeded_user.id)


async def test_undo_refuses_when_field_edited_after_apply(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U",
                       source_url=URL, previous_value=None)
    db.add(s)
    await db.commit()
    await service.approve(db, s, seeded_user.id)
    m.ru_size = 3
    await db.commit()
    with pytest.raises(service.FieldChanged):
        await service.undo(db, s, seeded_user.id)
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `service.py`**

```python
"""Spec lookup business rules — shared by the worker and the routes.
Nothing here commits; callers own the transaction."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.assets.units import apply_unit_pairs
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.spec_lookup.fields import (
    blank_conditions, column_payload, current_value, enabled_fields, is_blank,
)
from serversherpa.spec_lookup.provider import LookupResult
from serversherpa.spec_lookup.verify import verify_finding

AI_LOOKUP = "ai_lookup"
PRIORITY_SWEEP = 0
PRIORITY_BATCH = 10
PRIORITY_MODEL = 20
ACTIVE = ("queued", "running")


class FieldChanged(Exception):
    pass


class BadState(Exception):
    pass


async def eligible_model_ids(db: AsyncSession, cfg: dict, *, respect_retry: bool = True,
                             now: datetime | None = None) -> list[uuid.UUID]:
    fields = enabled_fields(cfg)
    if not fields:
        return []
    now = now or datetime.now(UTC)
    active = exists().where(SpecLookupJob.model_id == AssetModel.id,
                            SpecLookupJob.status.in_(ACTIVE))
    q = (select(AssetModel.id)
         .where(AssetModel.private.is_(False), AssetModel.spec_lookup_skip.is_(False),
                or_(*blank_conditions(fields)), ~active)
         .order_by(AssetModel.make, AssetModel.model))
    if respect_retry:
        days = int(cfg.get("retry_after_days") or 0)
        never = AssetModel.specs_looked_up_at.is_(None)
        if days > 0:
            q = q.where(or_(never, AssetModel.specs_looked_up_at < now - timedelta(days=days)))
        else:
            q = q.where(never)
    return list(await db.scalars(q))


async def enqueue(db: AsyncSession, model_ids: list[uuid.UUID], priority: int,
                  requested_by: uuid.UUID | None) -> int:
    if not model_ids:
        return 0
    await db.execute(
        update(SpecLookupJob)
        .where(SpecLookupJob.model_id.in_(model_ids), SpecLookupJob.status == "queued",
               SpecLookupJob.priority < priority)
        .values(priority=priority, next_attempt_at=None))
    stmt = (insert(SpecLookupJob)
            .values([{"model_id": mid, "priority": priority, "requested_by": requested_by}
                     for mid in model_ids])
            .on_conflict_do_nothing()
            .returning(SpecLookupJob.id))
    return len((await db.execute(stmt)).all())


async def _apply(db: AsyncSession, m: AssetModel, s: SpecSuggestion,
                 actor_id: uuid.UUID | None, value: str | None, action: str) -> None:
    data = apply_unit_pairs(column_payload(s.field, value, s.unit))
    fields = list(data.keys())
    before = snapshot(m, fields)
    for col, v in data.items():
        setattr(m, col, v)
    changes = diff(before, snapshot(m, fields))
    if changes:
        m.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, entity_type="asset_model", entity_id=str(m.id),
              action=action, changes=changes)


async def record_result(db: AsyncSession, job: SpecLookupJob, m: AssetModel,
                        result: LookupResult, cfg: dict) -> list[SpecSuggestion]:
    now = datetime.now(UTC)
    job.input_tokens += result.input_tokens
    job.output_tokens += result.output_tokens
    job.search_count += result.search_count
    m.specs_looked_up_at = now
    out: list[SpecSuggestion] = []
    seen_fields: set[str] = set()
    for f in result.findings:
        if f.field in seen_fields:          # first verified value per field wins
            continue
        v = verify_finding(f.field, f.value, f.unit, f.quote, f.source_url, result.seen_urls)
        if v is None:
            continue
        seen_fields.add(v.field)
        await db.execute(
            update(SpecSuggestion)
            .where(SpecSuggestion.model_id == m.id, SpecSuggestion.field == v.field,
                   SpecSuggestion.status == "pending")
            .values(status="rejected", decided_at=now))
        s = SpecSuggestion(model_id=m.id, job_id=job.id, field=v.field, value=v.value,
                           unit=v.unit, quote=v.quote[:2000], source_url=v.source_url,
                           previous_value=current_value(m, v.field, v.unit),
                           status="pending")
        db.add(s)
        if cfg.get("auto_apply") and v.field != "knowledge" and is_blank(m, v.field):
            await _apply(db, m, s, None, v.value, "spec_lookup.apply")
            s.status = "applied"
            s.decided_at = now
        out.append(s)
    await db.flush()
    return out


async def _model(db: AsyncSession, s: SpecSuggestion) -> AssetModel:
    m = await db.get(AssetModel, s.model_id)
    if m is None:
        raise BadState("model_gone")
    return m


async def approve(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status != "pending":
        raise BadState(s.status)
    m = await _model(db, s)
    if current_value(m, s.field, s.unit) != s.previous_value:
        raise FieldChanged(current_value(m, s.field, s.unit))
    await _apply(db, m, s, actor_id, s.value, "spec_lookup.apply")
    s.status = "approved"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)


async def reject(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status != "pending":
        raise BadState(s.status)
    s.status = "rejected"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)


async def undo(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status not in ("applied", "approved"):
        raise BadState(s.status)
    m = await _model(db, s)
    if current_value(m, s.field, s.unit) != s.value:
        raise FieldChanged(current_value(m, s.field, s.unit))
    await _apply(db, m, s, actor_id, s.previous_value, "spec_lookup.undo")
    s.status = "reverted"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)
```

Note on `undo` restoring a unit pair: `column_payload(field, None, unit)` gives `{height_in: None}` and `apply_unit_pairs` clears the partner too. When `previous_value` is not None (approve over a non-blank field), restoring the one side recomputes the partner — acceptable, documented here.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(spec-lookup): service — eligibility, enqueue, record/verify, approve/reject/undo"`

---

### Task 7: Queue + worker + CLI + Procfile

**Files:**
- Create: `api/src/serversherpa/spec_lookup/jobs.py`
- Create: `api/src/serversherpa/spec_lookup/worker.py`
- Modify: `api/src/serversherpa/cli.py` (new command after `label_worker`)
- Modify: `Procfile.dev` (new line after `labelsvc`)
- Test: `api/tests/test_spec_lookup_worker.py`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `jobs.claim_next(db) -> SpecLookupJob | None` (priority desc, created_at; due `next_attempt_at`), `jobs.requeue_stale(db) -> int`
  - `worker.BACKOFF = (60, 300, 1800)`; `worker.MAX_ATTEMPTS = 3`
  - `async def worker.process_job(db, job, provider: LookupProvider | None) -> str` (final status)
  - `async def worker.sweep(db, provider_configured: bool) -> int`
  - `async def worker.run_once(sessionmaker, provider_factory=get_provider) -> bool`
  - `async def worker.run_forever(poll_seconds: float = 2.0) -> None`
  - process name `"spec-lookup-worker"`

- [ ] **Step 1: Failing test**

```python
"""spec-lookup-worker: claim order, private re-check, success/record,
retry backoff, not-configured, refusal, sweep."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import jobs, worker
from serversherpa.spec_lookup.provider import (
    Finding, LookupResult, ProviderFailed, ProviderNotConfigured, ProviderRetryable,
)

URL = "https://www.hpe.com/a"


class FakeProvider:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    async def lookup(self, **kw):
        self.calls.append(kw)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    async def ping(self):
        return None

    async def aclose(self):
        return None


OK = LookupResult(findings=[Finding("ru_size", "1", None, "1U", URL)],
                  seen_urls={URL}, input_tokens=10, output_tokens=5, search_count=1)


async def _setup(db, **kw):
    m = AssetModel(make="HPE", model="DL320", **kw)
    db.add(m)
    await db.flush()
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.commit()
    return m, job


async def _reload(db, cls, id_):
    return await db.scalar(select(cls).where(cls.id == id_).execution_options(populate_existing=True))


async def test_claim_order_priority_then_age(db):
    a = AssetModel(make="A", model="a")
    b = AssetModel(make="B", model="b")
    c = AssetModel(make="C", model="c")
    db.add_all([a, b, c])
    await db.flush()
    db.add(SpecLookupJob(model_id=a.id, priority=0))
    db.add(SpecLookupJob(model_id=b.id, priority=20))
    db.add(SpecLookupJob(model_id=c.id, priority=20,
                         next_attempt_at=datetime.now(UTC) + timedelta(minutes=5)))
    await db.commit()
    job = await jobs.claim_next(db)
    assert job.model_id == b.id and job.status == "running"


async def test_success_records_suggestions(db):
    m, job = await _setup(db)
    p = FakeProvider(OK)
    assert await worker.run_once(get_sessionmaker(), provider_factory=lambda: p) is True
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.finished_at is not None and job.search_count == 1
    assert p.calls[0]["make"] == "HPE" and p.calls[0]["fields"][0] == "ru_size"
    assert (await db.scalar(select(SpecSuggestion))).value == "1"


async def test_private_is_never_sent(db):
    m, job = await _setup(db, private=True)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert p.calls == [] and job.status == "done" and job.error == "private"


async def test_nothing_wanted_finishes_without_a_call(db):
    m, job = await _setup(db, ru_size=1, weight_lbs=1, weight_kg=0.45, length_in=1,
                          length_cm=2.54, width_in=1, width_cm=2.54, height_in=1, height_cm=2.54)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert p.calls == []
    assert (await _reload(db, SpecLookupJob, job.id)).error == "nothing_to_look_up"


async def test_retryable_backs_off_then_fails(db):
    m, job = await _setup(db)
    p = FakeProvider(ProviderRetryable("RateLimitError"))
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "queued" and job.attempts == 1 and job.next_attempt_at is not None
    assert (await _reload(db, AssetModel, m.id)).specs_looked_up_at is None
    job.attempts = worker.MAX_ATTEMPTS - 1
    job.next_attempt_at = None
    await db.commit()
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert (await _reload(db, SpecLookupJob, job.id)).status == "failed"


async def test_not_configured_and_refusal(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: None)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error == "not_configured"
    m2 = AssetModel(make="X", model="y")
    db.add(m2)
    await db.flush()
    job2 = SpecLookupJob(model_id=m2.id)
    db.add(job2)
    await db.commit()
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderFailed("refusal")))
    job2 = await _reload(db, SpecLookupJob, job2.id)
    assert job2.status == "failed" and job2.error == "refusal"
    assert (await _reload(db, AssetModel, m2.id)).specs_looked_up_at is not None


async def test_401_mid_run_is_not_configured(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderNotConfigured("x")))
    assert (await _reload(db, SpecLookupJob, job.id)).error == "not_configured"


async def test_sweep_respects_toggle_and_configuration(db):
    from serversherpa.db.models import SystemConfig
    db.add(AssetModel(make="HPE", model="DL320"))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0          # background off by default
    db.add(SystemConfig(section="ai_lookup", data={"background_enabled": True}))
    await db.commit()
    assert await worker.sweep(db, provider_configured=False) == 0
    assert await worker.sweep(db, provider_configured=True) == 1
```

(If `system_config` already has an `ai_lookup` row from the conftest reset, use `merge`/update instead of `add` — check the reset block at conftest.py:390.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: `jobs.py`**

```python
"""spec_lookup_jobs queue helpers — the label queue's shape (see
labels/generate/jobs.py) plus priority and a retry clock. One worker process."""

import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import SpecLookupJob

STALE_MINUTES = 15


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def claim_next(db: AsyncSession) -> SpecLookupJob | None:
    now = datetime.now(UTC)
    job = await db.scalar(
        select(SpecLookupJob)
        .where(SpecLookupJob.status == "queued",
               or_(SpecLookupJob.next_attempt_at.is_(None),
                   SpecLookupJob.next_attempt_at <= now))
        .order_by(SpecLookupJob.priority.desc(), SpecLookupJob.created_at)
        .limit(1).with_for_update(skip_locked=True))
    if job is None:
        return None
    job.status = "running"
    job.started_at = now
    job.heartbeat_at = now
    job.worker_id = _worker_id()
    await db.commit()
    return job


async def requeue_stale(db: AsyncSession) -> int:
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    liveness = func.coalesce(SpecLookupJob.heartbeat_at, SpecLookupJob.started_at)
    rows = (await db.scalars(
        select(SpecLookupJob).where(SpecLookupJob.status == "running", liveness < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in rows:
        job.status = "queued"
        job.started_at = None
        job.heartbeat_at = None
        job.worker_id = None
    await db.commit()
    return len(rows)
```

- [ ] **Step 4: `worker.py`**

```python
"""The spec-lookup-worker loop (`serversherpa spec-lookup-worker`): claims
spec_lookup_jobs one at a time, asks the provider, verifies and records
suggestions; sweeps eligible models into the queue when Background search
is on. Survives DB blips like the label worker."""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AssetModel, AssetModelAlias, SpecLookupJob
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.fields import wanted_fields
from serversherpa.spec_lookup.jobs import claim_next, requeue_stale
from serversherpa.spec_lookup.provider import (
    ProviderFailed, ProviderNotConfigured, ProviderRetryable, get_provider, is_configured,
)
from serversherpa.system.config_store import read_section

logger = logging.getLogger("serversherpa.spec_lookup.worker")

PROCESS_NAME = "spec-lookup-worker"
BACKOFF = (60, 300, 1800)
MAX_ATTEMPTS = 3
STALE_SWEEP_SECONDS = 60
SWEEP_SECONDS = 60
ERROR_MAX = 2000


def _finish(job: SpecLookupJob, status: str, error: str | None = None) -> str:
    job.status = status
    job.error = error[:ERROR_MAX] if error else None
    job.finished_at = datetime.now(UTC)
    return status


async def process_job(db, job: SpecLookupJob, provider) -> str:
    m = await db.get(AssetModel, job.model_id)
    if m is None:
        return _finish(job, "done", "model_gone")
    if m.private:                                   # re-checked right before any call
        return _finish(job, "done", "private")
    if m.spec_lookup_skip:
        return _finish(job, "done", "skipped")
    cfg = await read_section(db, service.AI_LOOKUP)
    fields = wanted_fields(m, cfg)
    if not fields:
        m.specs_looked_up_at = datetime.now(UTC)
        return _finish(job, "done", "nothing_to_look_up")
    if provider is None:
        return _finish(job, "failed", "not_configured")
    aliases = list(await db.scalars(
        select(AssetModelAlias.alias).where(AssetModelAlias.model_id == m.id)))
    job.attempts += 1
    try:
        result = await provider.lookup(make=m.make, model=m.model, aliases=aliases,
                                       category=m.category, fields=fields)
    except ProviderNotConfigured:
        return _finish(job, "failed", "not_configured")
    except ProviderRetryable as exc:
        if job.attempts >= MAX_ATTEMPTS:
            return _finish(job, "failed", f"retries_exhausted: {exc}")
        job.status = "queued"
        job.started_at = job.heartbeat_at = job.worker_id = None
        job.next_attempt_at = datetime.now(UTC) + timedelta(
            seconds=BACKOFF[min(job.attempts - 1, len(BACKOFF) - 1)])
        job.error = str(exc)[:ERROR_MAX]
        return "queued"
    except ProviderFailed as exc:
        m.specs_looked_up_at = datetime.now(UTC)
        return _finish(job, "failed", str(exc))
    await service.record_result(db, job, m, result, cfg)
    return _finish(job, "done")


async def sweep(db, provider_configured: bool) -> int:
    cfg = await read_section(db, service.AI_LOOKUP)
    if not cfg.get("background_enabled") or not provider_configured:
        return 0
    ids = await service.eligible_model_ids(db, cfg)
    n = await service.enqueue(db, ids, service.PRIORITY_SWEEP, None)
    await db.commit()
    return n


async def run_once(sessionmaker, provider_factory=get_provider) -> bool:
    from serversherpa.system.db_logging import install
    install(PROCESS_NAME)

    async with sessionmaker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        job_id = job.id
        provider = provider_factory()
        try:
            status = await process_job(db, job, provider)
            await db.commit()
        except Exception as exc:
            logger.exception("job %s crashed: %s", job_id, exc)
            await db.rollback()
            async with sessionmaker() as fin:
                row = await fin.get(SpecLookupJob, job_id)
                if row is not None:
                    _finish(row, "failed", f"worker_error: {exc}")
                    await fin.commit()
            status = "failed"
        finally:
            if provider is not None:
                await provider.aclose()
        logger.info("job %s finished status=%s", job_id, status)
        return True


async def _guarded(label: str, coro_fn, state: dict) -> None:
    try:
        await coro_fn()
        state[label] = False
    except Exception:
        if not state.get(label):
            logger.warning("%s failed — retrying", label, exc_info=True)
        state[label] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install(PROCESS_NAME)
    pause_state = {"paused": False}
    check_state: dict = {}
    fail_state: dict = {}
    heartbeat = start_heartbeat(PROCESS_NAME, "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()

    async def stale():
        async with maker() as db:
            if await requeue_stale(db):
                logger.info("re-queued stale spec lookups")

    async def do_sweep():
        async with maker() as db:
            n = await sweep(db, is_configured())
            if n:
                logger.info("sweep queued %d model(s)", n)

    try:
        await _guarded("stale sweep", stale, fail_state)
        stale_at = sweep_at = 0.0
        logger.info("spec lookup worker online — watching the queue")
        while True:
            if await poll_workers_paused(maker, check_state):
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            pause_state["paused"] = False
            now = time.monotonic()
            if now - stale_at >= STALE_SWEEP_SECONDS:
                stale_at = now
                await _guarded("stale sweep", stale, fail_state)
            if now - sweep_at >= SWEEP_SECONDS:
                sweep_at = now
                await _guarded("eligibility sweep", do_sweep, fail_state)
            worked = False
            try:
                worked = await run_once(maker)
                fail_state["claim"] = False
            except Exception:
                if not fail_state.get("claim"):
                    logger.warning("could not poll the spec lookup queue — retrying",
                                   exc_info=True)
                fail_state["claim"] = True
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

- [ ] **Step 5: CLI + Procfile**

In `cli.py`, after the `label_worker` command, add (mirroring it exactly):

```python
def _run_spec_lookup_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    async def _run() -> None:
        from serversherpa.spec_lookup import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command()
def spec_lookup_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one job, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the spec lookup worker — asks Claude for missing Makes / Models
    specs one model at a time and records verified suggestions."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[spec-lookup-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_spec_lookup_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.spec_lookup import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 job" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())
```

`Procfile.dev`, after the `labelsvc:` line:

```
specsvc: api/.venv/bin/serversherpa spec-lookup-worker --reload
```

- [ ] **Step 6: Run** the worker test plus `tests/test_cli_report_worker.py -q` (sanity) — expect PASS. Also `.venv/bin/serversherpa spec-lookup-worker --help` prints the help.
- [ ] **Step 7: Commit** — `git commit -m "feat(spec-lookup): spec-lookup-worker — queue, backoff, private re-check, sweep, CLI"`

---

### Task 8: API routes

**Files:**
- Create: `api/src/serversherpa/api/routes/spec_lookup.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append spec lookup schemas)
- Modify: the router registration in `api/src/serversherpa/api/app.py` (follow how `asset_models.router` is included)
- Test: `api/tests/test_spec_lookup_api.py`

**Interfaces:**
- Consumes: Tasks 2–7. `_require_global` and `_err` are imported from `routes/asset_models.py`.
- Produces (JSON shapes the portal uses in Tasks 9–11):
  - `GET /spec-lookup/status` → `{configured, background_enabled, queued, running_model: {id, make, model} | null, last_finished_at, pending_count, month: {lookups, input_tokens, output_tokens, searches, est_cost_usd}}`
  - `POST /spec-lookup/queue` `{model_ids?: uuid[]}` → `{queued: int, skipped: [{id, reason}]}`; 409 `not_configured`
  - `GET /spec-lookup/suggestions?status=pending|applied|all&model_id=` → `SpecSuggestionOut[]` = `{id, model_id, make, model, field, value, unit, current_value, source_url, quote, status, created_at, decided_at}`
  - `POST /spec-lookup/suggestions/{id}/approve|reject|undo` → `SpecSuggestionOut`; 404 `suggestion_not_found`, 409 `field_changed` (`detail.current`), 409 `bad_state`
  - `POST /spec-lookup/suggestions/bulk` `{ids: uuid[], action: "approve"|"reject"}` → `{results: [{id, ok, error, make, model, field, value}]}`
  - `GET /spec-lookup/dev` (devtools view) → `{model, max_searches, max_fetches, key_set, key_last4, worker_status, worker_heartbeat_at}`
  - `POST /spec-lookup/dev/test` (devtools view) → `{ok, latency_ms, error}`

- [ ] **Step 1: Failing test**

```python
"""/spec-lookup routes: permissions, status, queue, suggestions lifecycle, bulk, dev."""
from sqlalchemy import select

from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import provider as provider_mod
from tests.test_assets_api import login
from tests.test_initiatives_client_scope import client_login
from tests.test_system_api import _developer_headers

URL = "https://www.hpe.com/a"


def _configured(monkeypatch, ok=True):
    class P:
        async def ping(self):
            if not ok:
                raise provider_mod.ProviderNotConfigured("not_configured")

        async def aclose(self):
            return None
    monkeypatch.setattr(provider_mod, "is_configured", lambda: True)
    monkeypatch.setattr(provider_mod, "get_provider", lambda: P())


async def _m(db, **kw):
    m = AssetModel(make=kw.pop("make", "HPE"), model=kw.pop("model", "DL320"), **kw)
    db.add(m)
    await db.commit()
    return m


async def _sugg(db, m, **kw):
    s = SpecSuggestion(model_id=m.id, field=kw.get("field", "ru_size"),
                       value=kw.get("value", "1"), unit=kw.get("unit"),
                       quote="1U", source_url=URL, previous_value=None,
                       status=kw.get("status", "pending"))
    db.add(s)
    await db.commit()
    return s


async def test_client_user_refused(client, db, seeded_user):
    from serversherpa.db.models import Client
    c = Client(name="Acme")
    db.add(c)
    await db.commit()
    hdrs = await client_login(db, client, c.id)
    assert (await client.get("/spec-lookup/status", headers=hdrs)).status_code == 403


async def test_status(client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    m = await _m(db)
    await _sugg(db, m)
    body = (await client.get("/spec-lookup/status", headers=hdrs)).json()
    assert body["configured"] is False and body["pending_count"] == 1
    assert body["month"]["lookups"] == 0


async def test_queue_requires_configuration(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    resp = await client.post("/spec-lookup/queue", headers=hdrs, json={"model_ids": [str(m.id)]})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_configured"


async def test_queue_ids_skips_private_and_skip(client, db, seeded_user, monkeypatch):
    _configured(monkeypatch)
    hdrs = await login(client)
    ok = await _m(db, model="ok", specs_looked_up_at=None)
    priv = await _m(db, model="priv", private=True)
    junk = await _m(db, model="junk", spec_lookup_skip=True)
    resp = await client.post("/spec-lookup/queue", headers=hdrs,
                             json={"model_ids": [str(ok.id), str(priv.id), str(junk.id)]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["queued"] == 1
    assert {(s["id"], s["reason"]) for s in body["skipped"]} == {
        (str(priv.id), "private"), (str(junk.id), "skipped")}
    job = await db.scalar(select(SpecLookupJob))
    assert job.priority == 20 and job.requested_by == seeded_user.id


async def test_queue_all_eligible(client, db, seeded_user, monkeypatch):
    _configured(monkeypatch)
    hdrs = await login(client)
    await _m(db, model="a")
    await _m(db, model="b")
    resp = await client.post("/spec-lookup/queue", headers=hdrs, json={})
    assert resp.json()["queued"] == 2


async def test_suggestion_lifecycle(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    s = await _sugg(db, m)
    listed = (await client.get("/spec-lookup/suggestions?status=pending", headers=hdrs)).json()
    assert [x["id"] for x in listed] == [str(s.id)] and listed[0]["make"] == "HPE"
    assert listed[0]["current_value"] is None
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["status"] == "approved"
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "bad_state"
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/undo", headers=hdrs)
    assert resp.json()["status"] == "reverted"


async def test_field_changed_409(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db, ru_size=4)
    s = await _sugg(db, m)
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "field_changed", "current": "4"}


async def test_bulk(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    a = await _sugg(db, m, field="ru_size")
    b = await _sugg(db, m, field="height", value="1.7", unit="in", status="rejected")
    resp = await client.post("/spec-lookup/suggestions/bulk", headers=hdrs,
                             json={"ids": [str(a.id), str(b.id)], "action": "approve"})
    res = {r["id"]: r for r in resp.json()["results"]}
    assert res[str(a.id)]["ok"] is True
    assert res[str(b.id)]["ok"] is False and res[str(b.id)]["error"] == "bad_state"


async def test_dev_endpoints_gated_and_masked(client, db, seeded_user, monkeypatch):
    staff = await login(client)
    assert (await client.get("/spec-lookup/dev", headers=staff)).status_code == 403
    dev = await _developer_headers(db, client)
    body = (await client.get("/spec-lookup/dev", headers=dev)).json()
    assert body["key_set"] is False and body["key_last4"] is None
    assert body["model"] == "claude-sonnet-5" and body["worker_status"] in ("failed", "stopped", "missing")
    _configured(monkeypatch, ok=False)
    body = (await client.post("/spec-lookup/dev/test", headers=dev)).json()
    assert body["ok"] is False and body["error"] == "not_configured"
```

(Check `_developer_headers(db, client)` exists in `tests/test_system_api.py`; check the `Client` model's required columns in `db/models.py` and set them.)

- [ ] **Step 2: Run — expect FAIL (404s).**

- [ ] **Step 3: Schemas** — append to `schemas.py`:

```python
class SpecLookupQueueIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_ids: list[uuid.UUID] | None = None


class SpecSuggestionOut(BaseModel):
    id: uuid.UUID
    model_id: uuid.UUID
    make: str
    model: str
    field: str
    value: str
    unit: str | None
    current_value: str | None
    source_url: str
    quote: str
    status: str
    created_at: datetime
    decided_at: datetime | None


class SpecSuggestionBulkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    action: Literal["approve", "reject"]
```

(Import `Literal` from `typing` if schemas.py doesn't already.)

- [ ] **Step 4: Routes** — `routes/spec_lookup.py`:

```python
"""Makes / Models spec lookup: queue, status, suggestion review, and the
Developer › System Config panel. Global (internal) users only — the same
rule as /asset-models."""

import time
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.asset_models import _err, _require_global
from serversherpa.api.schemas import (
    SpecLookupQueueIn, SpecSuggestionBulkIn, SpecSuggestionOut,
)
from serversherpa.config import get_settings
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion, SystemProcess
from serversherpa.spec_lookup import provider as provider_mod
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.fields import current_value
from serversherpa.spec_lookup.worker import PROCESS_NAME
from serversherpa.system.config_store import read_section
from serversherpa.system.registry import derive_status

router = APIRouter(prefix="/spec-lookup", tags=["assets"])


def _out(s: SpecSuggestion, m: AssetModel) -> SpecSuggestionOut:
    return SpecSuggestionOut(
        id=s.id, model_id=s.model_id, make=m.make, model=m.model, field=s.field,
        value=s.value, unit=s.unit, current_value=current_value(m, s.field, s.unit),
        source_url=s.source_url, quote=s.quote, status=s.status,
        created_at=s.created_at, decided_at=s.decided_at)


@router.get("/status")
async def status(db: DbSession,
                 actor: AuthContext = require_permission("asset_models", "view")) -> dict:
    _require_global(actor)
    cfg = await read_section(db, service.AI_LOOKUP)
    queued = await db.scalar(select(func.count()).select_from(SpecLookupJob)
                             .where(SpecLookupJob.status == "queued"))
    running = (await db.execute(
        select(AssetModel.id, AssetModel.make, AssetModel.model)
        .join(SpecLookupJob, SpecLookupJob.model_id == AssetModel.id)
        .where(SpecLookupJob.status == "running").limit(1))).first()
    last = await db.scalar(select(func.max(SpecLookupJob.finished_at)))
    pending = await db.scalar(select(func.count()).select_from(SpecSuggestion)
                              .where(SpecSuggestion.status == "pending"))
    month_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    lookups, inp, out, searches = (await db.execute(
        select(func.count(), func.coalesce(func.sum(SpecLookupJob.input_tokens), 0),
               func.coalesce(func.sum(SpecLookupJob.output_tokens), 0),
               func.coalesce(func.sum(SpecLookupJob.search_count), 0))
        .where(SpecLookupJob.finished_at >= month_start,
               SpecLookupJob.input_tokens > 0))).one()
    return {
        "configured": provider_mod.is_configured(),
        "background_enabled": bool(cfg.get("background_enabled")),
        "queued": queued, "last_finished_at": last, "pending_count": pending,
        "running_model": ({"id": running.id, "make": running.make, "model": running.model}
                          if running else None),
        "month": {"lookups": lookups, "input_tokens": inp, "output_tokens": out,
                  "searches": searches,
                  "est_cost_usd": round(provider_mod.estimate_cost(inp, out, searches), 2)},
    }


@router.post("/queue")
async def queue(body: SpecLookupQueueIn, db: DbSession,
                actor: AuthContext = require_permission("asset_models", "change")) -> dict:
    _require_global(actor)
    if not provider_mod.is_configured():
        raise _err(409, "not_configured")
    skipped: list[dict] = []
    if body.model_ids is None:
        cfg = await read_section(db, service.AI_LOOKUP)
        ids = await service.eligible_model_ids(db, cfg)
        priority = service.PRIORITY_BATCH
    else:
        rows = {m.id: m for m in await db.scalars(
            select(AssetModel).where(AssetModel.id.in_(body.model_ids)))}
        ids = []
        for mid in body.model_ids:
            m = rows.get(mid)
            reason = ("not_found" if m is None else "private" if m.private
                      else "skipped" if m.spec_lookup_skip else None)
            if reason:
                skipped.append({"id": mid, "reason": reason})
            else:
                ids.append(mid)
        priority = service.PRIORITY_MODEL
    n = await service.enqueue(db, ids, priority, actor.person.id)
    await db.commit()
    return {"queued": n, "skipped": skipped}


@router.get("/suggestions", response_model=list[SpecSuggestionOut])
async def list_suggestions(
    db: DbSession, status: str = "pending", model_id: uuid.UUID | None = None,
    actor: AuthContext = require_permission("asset_models", "view"),
) -> list[SpecSuggestionOut]:
    _require_global(actor)
    q = (select(SpecSuggestion, AssetModel)
         .join(AssetModel, AssetModel.id == SpecSuggestion.model_id)
         .order_by(SpecSuggestion.created_at.desc()).limit(1000))
    if status == "applied":
        q = q.where(SpecSuggestion.status.in_(("applied", "approved")))
    elif status != "all":
        q = q.where(SpecSuggestion.status == status)
    if model_id is not None:
        q = q.where(SpecSuggestion.model_id == model_id)
    return [_out(s, m) for s, m in (await db.execute(q)).all()]


async def _act(db, s: SpecSuggestion, action: str, actor_id: uuid.UUID) -> None:
    fn = {"approve": service.approve, "reject": service.reject, "undo": service.undo}[action]
    await fn(db, s, actor_id)


@router.post("/suggestions/{suggestion_id}/{action}", response_model=SpecSuggestionOut)
async def act(suggestion_id: uuid.UUID, action: str, db: DbSession,
              actor: AuthContext = require_permission("asset_models", "change")
              ) -> SpecSuggestionOut:
    _require_global(actor)
    if action not in ("approve", "reject", "undo"):
        raise _err(404, "not_found")
    s = await db.get(SpecSuggestion, suggestion_id)
    if s is None:
        raise _err(404, "suggestion_not_found")
    try:
        await _act(db, s, action, actor.person.id)
    except service.FieldChanged as exc:
        await db.rollback()
        raise _err(409, "field_changed", current=exc.args[0] if exc.args else None)
    except service.BadState:
        await db.rollback()
        raise _err(409, "bad_state")
    await db.commit()
    m = await db.get(AssetModel, s.model_id)
    return _out(s, m)


@router.post("/suggestions/bulk")
async def bulk(body: SpecSuggestionBulkIn, db: DbSession,
               actor: AuthContext = require_permission("asset_models", "change")) -> dict:
    _require_global(actor)
    results = []
    for sid in body.ids:
        s = await db.get(SpecSuggestion, sid)
        if s is None:
            results.append({"id": sid, "ok": False, "error": "suggestion_not_found",
                            "make": None, "model": None, "field": None, "value": None})
            continue
        m = await db.get(AssetModel, s.model_id)
        row = {"id": sid, "make": m.make, "model": m.model, "field": s.field, "value": s.value}
        try:
            async with db.begin_nested():
                await _act(db, s, body.action, actor.person.id)
            results.append({**row, "ok": True, "error": None})
        except service.FieldChanged:
            results.append({**row, "ok": False, "error": "field_changed"})
        except service.BadState:
            results.append({**row, "ok": False, "error": "bad_state"})
    await db.commit()
    return {"results": results}


@router.get("/dev")
async def dev_info(db: DbSession,
                   actor: AuthContext = require_permission("devtools", "view")) -> dict:
    s = get_settings()
    key = s.anthropic_api_key.get_secret_value()
    proc = await db.get(SystemProcess, PROCESS_NAME)
    worker_status = ("missing" if proc is None else
                     derive_status(proc.heartbeat_at, proc.stopped_at, datetime.now(UTC),
                                   proc.meta))
    return {"model": s.spec_lookup_model, "max_searches": s.spec_lookup_max_searches,
            "max_fetches": s.spec_lookup_max_fetches, "key_set": bool(key),
            "key_last4": key[-4:] if len(key) >= 8 else None,
            "worker_status": worker_status,
            "worker_heartbeat_at": proc.heartbeat_at if proc else None}


@router.post("/dev/test")
async def dev_test(actor: AuthContext = require_permission("devtools", "view")) -> dict:
    p = provider_mod.get_provider()
    if p is None:
        return {"ok": False, "latency_ms": None, "error": "not_configured"}
    started = time.monotonic()
    try:
        await p.ping()
        return {"ok": True, "latency_ms": int((time.monotonic() - started) * 1000),
                "error": None}
    except provider_mod.ProviderError as exc:
        return {"ok": False, "latency_ms": None, "error": str(exc)[:300]}
    finally:
        await p.aclose()
```

Notes for the implementer:
- `provider_mod.is_configured()` and `provider_mod.get_provider()` must be called through the module (not `from ... import`) so the test's monkeypatch takes effect.
- `bulk` uses `begin_nested()` (SAVEPOINT) so one failing row doesn't roll back the others; if the session is in autobegin state this works in SQLAlchemy 2.x — verify with the test.
- Register the router in `app.py` exactly the way `asset_models.router` is registered.
- Confirm `derive_status`'s signature (system/registry.py:20) — `(heartbeat_at, stopped_at, now, meta=None)`.

- [ ] **Step 5: Run** `tests/test_spec_lookup_api.py -q` — expect PASS. Then run the whole spec lookup set plus `tests/test_asset_models_api.py tests/test_system_api.py -q`.
- [ ] **Step 6: Commit** — `git commit -m "feat(spec-lookup): /spec-lookup routes — status, queue, suggestions, bulk, dev panel"`

---

### Task 9: Portal — API client + Settings › AI lookup tab

**Files:**
- Modify: `portal/src/lib/api.ts` (near `getSecurityConfig`, ~line 3853; and `AssetModelItem` at 1915)
- Create: `portal/src/components/settings/AiLookupControls.tsx`
- Create: `portal/src/components/settings/AiLookupControls.test.tsx`
- Modify: `portal/src/pages/Settings.tsx` (tab list + route helper)
- Modify: `portal/src/App.tsx` (add `/settings/ai-lookup` route next to `/settings/security`, line ~195)

**Interfaces:**
- Produces in `api.ts`:

```ts
export interface AiLookupConfig {
  background_enabled: boolean; auto_apply: boolean; fields_specs: boolean;
  fields_mounting: boolean; fields_knowledge: boolean; retry_after_days: number;
}
export async function getAiLookupConfig(): Promise<AiLookupConfig>
export async function updateAiLookupConfig(p: Partial<AiLookupConfig>): Promise<AiLookupConfig>

export interface SpecLookupStatus {
  configured: boolean; background_enabled: boolean; queued: number;
  running_model: { id: string; make: string; model: string } | null;
  last_finished_at: string | null; pending_count: number;
  month: { lookups: number; input_tokens: number; output_tokens: number; searches: number; est_cost_usd: number };
}
export interface SpecSuggestion {
  id: string; model_id: string; make: string; model: string; field: string;
  value: string; unit: string | null; current_value: string | null;
  source_url: string; quote: string;
  status: 'pending' | 'applied' | 'approved' | 'rejected' | 'reverted';
  created_at: string; decided_at: string | null;
}
export interface SpecBulkResult { id: string; ok: boolean; error: string | null;
  make: string | null; model: string | null; field: string | null; value: string | null; }
export interface SpecLookupDev { model: string; max_searches: number; max_fetches: number;
  key_set: boolean; key_last4: string | null; worker_status: string; worker_heartbeat_at: string | null; }

export async function getSpecLookupStatus(): Promise<SpecLookupStatus>
export async function queueSpecLookup(modelIds?: string[]): Promise<{ queued: number; skipped: { id: string; reason: string }[] }>
export async function listSpecSuggestions(status: 'pending' | 'applied' | 'all', modelId?: string): Promise<SpecSuggestion[]>
export async function actOnSpecSuggestion(id: string, action: 'approve' | 'reject' | 'undo'): Promise<SpecSuggestion>
export async function bulkSpecSuggestions(ids: string[], action: 'approve' | 'reject'): Promise<{ results: SpecBulkResult[] }>
export async function getSpecLookupDev(): Promise<SpecLookupDev>
export async function testSpecLookup(): Promise<{ ok: boolean; latency_ms: number | null; error: string | null }>
```

  and `AssetModelItem` gains `private: boolean; spec_lookup_skip: boolean; specs_looked_up_at: string | null;`.

- [ ] **Step 1: api.ts** — write every function above following the exact shape of `getSecurityConfig`/`updateSecurityConfig` (read that code at ~3853–3895 first: `apiFetch(path, init)`, `if (!resp.ok) throw await ApiError.from(resp)` or whatever helper it uses, `return resp.json()`). `queueSpecLookup(undefined)` sends `{}`; with ids sends `{ model_ids }`. `listSpecSuggestions` builds `?status=...&model_id=...` with `URLSearchParams`. Update any test fixtures that build a full `AssetModelItem` literal (grep `review_dismissed_at:` in `portal/src` for them) to include the three new fields so `tsc` passes.

- [ ] **Step 2: Failing component test** — `AiLookupControls.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../lib/api';
import AiLookupControls from './AiLookupControls';

const CFG: api.AiLookupConfig = {
  background_enabled: false, auto_apply: false, fields_specs: true,
  fields_mounting: false, fields_knowledge: false, retry_after_days: 90,
};

describe('AiLookupControls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getAiLookupConfig').mockResolvedValue(CFG);
  });

  it('renders every setting from the server', async () => {
    render(<AiLookupControls canChange />);
    expect(await screen.findByText('Background search')).toBeInTheDocument();
    for (const label of ['Auto-apply confident matches', 'Specs', 'Mounting', 'Knowledge', 'Retry after']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Retry after (days)')).toHaveValue(90);
  });

  it('saves a toggle as a partial update', async () => {
    const upd = vi.spyOn(api, 'updateAiLookupConfig').mockResolvedValue({ ...CFG, auto_apply: true });
    render(<AiLookupControls canChange />);
    await screen.findByText('Auto-apply confident matches');
    await userEvent.click(screen.getAllByRole('switch')[1]);
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ auto_apply: true }));
  });

  it('is read-only without settings:change', async () => {
    render(<AiLookupControls canChange={false} />);
    await screen.findByText('Background search');
    screen.getAllByRole('switch').forEach((s) => expect(s).toBeDisabled());
  });
});
```

(Check `components/Switch.tsx` renders `role="switch"`; if it renders a checkbox, use `getAllByRole('checkbox')` instead — match `SecurityControls.test.tsx` if one exists.)

- [ ] **Step 3: Run** `npx vitest run src/components/settings/AiLookupControls.test.tsx` — expect FAIL.

- [ ] **Step 4: Implement `AiLookupControls.tsx`** — same structure as `SecurityControls.tsx`:

```tsx
/**
 * AiLookupControls — System settings › AI lookup. Controls the Makes /
 * Models spec lookup (Claude web search): the background sweep, auto-apply
 * of verified values into BLANK fields, which field groups are asked for,
 * and how long before a looked-up model is tried again.
 */
import { useEffect, useState } from 'react';

import { ApiError, getAiLookupConfig, updateAiLookupConfig, type AiLookupConfig } from '../../lib/api';
import { Switch } from '../Switch';

const ROWS: { key: keyof AiLookupConfig; title: string; hint: string }[] = [
  { key: 'background_enabled', title: 'Background search',
    hint: 'Look up models with missing details automatically, one at a time. Models marked Private or Skip are never sent.' },
  { key: 'auto_apply', title: 'Auto-apply confident matches',
    hint: 'Verified values fill blank fields right away and show as Applied with Undo. Existing values are never overwritten; knowledge notes always wait for review.' },
  { key: 'fields_specs', title: 'Specs', hint: 'RU size, weight, and dimensions.' },
  { key: 'fields_mounting', title: 'Mounting', hint: 'Mount type and rail type.' },
  { key: 'fields_knowledge', title: 'Knowledge', hint: 'A short note on what the product is, for the Field knowledge box.' },
];

export default function AiLookupControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<AiLookupConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [days, setDays] = useState('');

  useEffect(() => {
    void getAiLookupConfig()
      .then((c) => { setCfg(c); setDays(String(c.retry_after_days)); })
      .catch(() => setError('Could not load AI lookup settings.'));
  }, []);

  const patch = async (p: Partial<AiLookupConfig>) => {
    setBusy(true); setError('');
    try {
      const next = await updateAiLookupConfig(p);
      setCfg(next); setDays(String(next.retry_after_days));
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const locked = busy || !canChange || cfg === null;
  const saveDays = () => {
    const n = Number(days);
    if (!cfg || !Number.isInteger(n) || n < 0 || n === cfg.retry_after_days) {
      if (cfg) setDays(String(cfg.retry_after_days));
      return;
    }
    void patch({ retry_after_days: n });
  };

  return (
    <>
      {ROWS.map((r) => (
        <div className="set-row" key={r.key}>
          <div className="set-label"><b>{r.title}</b><span>{r.hint}</span></div>
          <Switch checked={Boolean(cfg?.[r.key])} disabled={locked}
                  onChange={(v) => void patch({ [r.key]: v } as Partial<AiLookupConfig>)} />
        </div>
      ))}
      <div className="set-row">
        <div className="set-label">
          <b>Retry after</b>
          <span>Days before a model that was already looked up is tried again by the background search. 0 means never; "Look up specs" on a model always runs.</span>
        </div>
        <input className="pf-input" type="number" min={0} max={3650} style={{ width: 90 }}
               aria-label="Retry after (days)" value={days} disabled={locked}
               onChange={(e) => setDays(e.target.value)} onBlur={saveDays}
               onKeyDown={(e) => { if (e.key === 'Enter') saveDays(); }} />
      </div>
      {error && <p className="pf-error" style={{ margin: '0 20px 14px' }}>{error}</p>}
    </>
  );
}
```

(Use whatever input class the settings forms already use — grep `settings.css`/`profile.css` for the number-input idiom; `pf-input` is the portal-form input. Don't invent a new style.)

- [ ] **Step 5: Wire the tab** — in `Settings.tsx`: `type Tab = 'administration' | 'security' | 'ai-lookup' | 'maintenance' | 'about'`; add `{ key: 'ai-lookup', label: 'AI lookup', to: '/settings/ai-lookup' }` after Security; `settingsTabFor` gains `if (pathname.startsWith('/settings/ai-lookup')) return 'ai-lookup';`; render:

```tsx
        {tab === 'ai-lookup' && (
          <section className="set-section">
            <div className="set-head">
              <h3>AI lookup</h3>
              <p>Fill missing Makes / Models details from the web through Claude. Only make and model names are sent.</p>
            </div>
            <AiLookupControls canChange={canChange} />
          </section>
        )}
```

`App.tsx`: add `<Route path="/settings/ai-lookup" element={<ProtectedRoute resource="settings"><Settings /></ProtectedRoute>} />` after the security route. If `Settings.test.tsx` asserts the tab list, update it.

- [ ] **Step 6: Run** the new test, `npx vitest run src/pages/Settings` (if present), and `npx tsc --noEmit -p .` — expect PASS/clean.
- [ ] **Step 7: Commit** — `git commit -m "feat(portal): Settings › AI lookup tab and spec lookup API client"`

---

### Task 10: Portal — Makes / Models "Spec lookup" tab, row action, Private/Skip in the edit form

**Files:**
- Create: `portal/src/components/assets/SpecLookupPanel.tsx`
- Create: `portal/src/components/assets/SpecLookupPanel.test.tsx`
- Modify: `portal/src/pages/AssetModels.tsx` (view union ~182, tablist ~406, panel render ~527, `ModelRowDetail` ~574)
- Modify: `portal/src/lib/assets.ts` (`ModelFormState`, `formFromModel`, `modelPayload`) and `portal/src/components/assets/ModelEditModal.tsx` (two switches in the form)
- Modify: `portal/src/styles/assets.css` (only if a new class is truly needed; prefer existing `rv-*`, `set-row`, `dir-empty`)

**Interfaces:**
- Consumes: Task 9's API client.
- Produces: `SpecLookupPanel` props `{ canChange: boolean; status: SpecLookupStatus | null; onChanged: () => void }` — the page owns `status` (it needs `pending_count` for the tab badge), mirroring how it owns `reviewData`.

- [ ] **Step 1: Failing test** — `SpecLookupPanel.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../lib/api';
import SpecLookupPanel from './SpecLookupPanel';

const STATUS: api.SpecLookupStatus = {
  configured: true, background_enabled: false, queued: 3, running_model: null,
  last_finished_at: null, pending_count: 1,
  month: { lookups: 4, input_tokens: 40000, output_tokens: 4000, searches: 9, est_cost_usd: 0.21 },
};
const SUGG: api.SpecSuggestion = {
  id: 's1', model_id: 'm1', make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6',
  unit: 'kg', current_value: null, source_url: 'https://www.hpe.com/psnow/doc/a1',
  quote: 'Maximum weight 13.6 kg', status: 'pending', created_at: '2026-09-28T12:00:00Z',
  decided_at: null,
};

const renderPanel = (status = STATUS, onChanged = vi.fn()) => render(
  <MemoryRouter><SpecLookupPanel canChange status={status} onChanged={onChanged} /></MemoryRouter>,
);

describe('SpecLookupPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'listSpecSuggestions').mockResolvedValue([SUGG]);
  });

  it('shows the status strip and a suggestion row', async () => {
    renderPanel();
    expect(await screen.findByText('DL320 Gen11')).toBeInTheDocument();
    expect(screen.getByText(/3 queued/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.21/)).toBeInTheDocument();
    expect(screen.getByText('13.6 kg')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'hpe.com' })).toHaveAttribute('href', SUGG.source_url);
  });

  it('approves a row and reloads', async () => {
    const onChanged = vi.fn();
    const act = vi.spyOn(api, 'actOnSpecSuggestion').mockResolvedValue({ ...SUGG, status: 'approved' });
    renderPanel(STATUS, onChanged);
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('s1', 'approve'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('queues every eligible model', async () => {
    const q = vi.spyOn(api, 'queueSpecLookup').mockResolvedValue({ queued: 5, skipped: [] });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Find missing specs' }));
    await waitFor(() => expect(q).toHaveBeenCalledWith(undefined));
    expect(await screen.findByText(/Queued 5 models/)).toBeInTheDocument();
  });

  it('explains when no API key is configured', async () => {
    renderPanel({ ...STATUS, configured: false });
    expect(await screen.findByText(/No Anthropic API key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find missing specs' })).toBeDisabled();
  });

  it('bulk approve ends in the per-row summary', async () => {
    vi.spyOn(api, 'bulkSpecSuggestions').mockResolvedValue({ results: [
      { id: 's1', ok: true, error: null, make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6' }] });
    renderPanel();
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    await userEvent.click(within(row).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    expect(await screen.findByText(/Download CSV/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `SpecLookupPanel.tsx`.** Required behavior (read `BulkApplySummary.tsx` fully first to learn its props — `result`, entity naming, link builder — and reuse it rather than building a second summary):

```tsx
/**
 * SpecLookupPanel — the Makes / Models "Spec lookup" view: a status strip
 * (queue, current model, month-to-date cost, Find missing specs) and the
 * suggestions Claude found, each with its source and quoted text. Approve /
 * Reject pending rows, Undo applied ones; bulk approve/reject ends in the
 * shared per-row summary. The PAGE owns `status` (its pending_count badges
 * the tab) and refetches on onChanged().
 */
import { useEffect, useState } from 'react';

import {
  ApiError, actOnSpecSuggestion, bulkSpecSuggestions, listSpecSuggestions, queueSpecLookup,
  type SpecBulkResult, type SpecLookupStatus, type SpecSuggestion,
} from '../../lib/api';
import DataTable from '../DataTable';
import BulkApplySummary from '../bulk/BulkApplySummary';

type Filter = 'pending' | 'applied' | 'all';
const FIELD_LABEL: Record<string, string> = {
  ru_size: 'RU size', weight: 'Weight', length: 'Length', width: 'Width', height: 'Height',
  mount_type: 'Mount type', rail_type: 'Rail type', knowledge: 'Knowledge',
};
const STATUS_LABEL: Record<SpecSuggestion['status'], string> = {
  pending: 'Pending', applied: 'Auto-applied', approved: 'Approved',
  rejected: 'Rejected', reverted: 'Undone',
};
const ERR: Record<string, string> = {
  field_changed: 'The field was changed since this was found — review the current value.',
  bad_state: 'Already decided.', not_configured: 'No Anthropic API key is configured.',
};

export const withUnit = (v: string | null, unit: string | null) =>
  v === null ? '—' : unit ? `${v} ${unit}` : v;
const domain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const msgFor = (e: unknown) => (e instanceof ApiError ? (ERR[e.code] ?? `Request failed (${e.code}).`)
  : 'Network error — nothing was changed.');
```

Then the component:
- `const [filter, setFilter] = useState<Filter>('pending')`, `rows`, `selected: Set<string>`, `busy`, `error`, `note` (e.g. "Queued 5 models."), `summary: SpecBulkResult[] | null`, `reload` counter; `useEffect` → `listSpecSuggestions(filter)` on `[filter, reload]`.
- **Status strip** (a `div.rv-panel` header line, text only): `{status.queued} queued · {running ? `looking up ${make} ${model}` : 'idle'} · this month {status.month.lookups} lookups, about ${status.month.est_cost_usd.toFixed(2)}` and, when `!status.configured`, a `dir-empty`-style notice: **"No Anthropic API key is configured."** "Set SS_ANTHROPIC_API_KEY in Developer › System Config › Environment." Button `mini-btn accent` **Find missing specs** (disabled when `!canChange || !status?.configured || busy`) → `queueSpecLookup(undefined)` → note `Queued ${n} model${n === 1 ? '' : 's'}.` → `onChanged()`.
- **Filter**: `div.segmented` with Pending / Applied / All buttons (same markup as the page's All | Review switch).
- **Table**: `<DataTable ariaLabel="Spec suggestions" columns=[select, Model, Field, Current, Suggested, Source, Quote, Status, Found, actions] rows=...>`. Cells: a checkbox (`aria-label={`Select ${make} ${model} ${field}`}`, only for pending rows); `<div className="pn"><b>{make}</b><span>{model}</span></div>`; field label; `withUnit(current_value, unit)` (mono); `withUnit(value, unit)` (mono; for knowledge show the text in `cell-sub`); `<a href={source_url} target="_blank" rel="noreferrer">{domain(source_url)}</a>`; quote truncated to 80 chars in `cell-sub` with `title={quote}`; `chip tag` with `STATUS_LABEL`; created date mono (use the portal's date formatter — grep `formatDate`/`fmtDate` in `lib/`); actions: pending → `Approve` (`mini-btn accent`) + `Reject` (`mini-btn`); applied/approved → `Undo` (`mini-btn`). Each calls `actOnSpecSuggestion(id, action)` then `setReload(k+1); onChanged()`; errors go to `pf-error` via `msgFor`.
- **Bulk bar** (only when `selected.size > 0`): `Approve selected (n)` / `Reject selected (n)` → `bulkSpecSuggestions([...selected], action)` → `setSummary(results)`, clear selection, reload, `onChanged()`.
- **Summary**: when `summary` is set, render `BulkApplySummary` mapping each result to a `BulkSummaryRow` (`row: index + 1`, `name: `${make} ${model} — ${FIELD_LABEL[field]}``, `action: ok ? 'updated' : 'skipped'`, `diff: ok ? { [field]: { new: value } } : null`), plus a note line for failures (`error` mapped through `ERR`). Close/“Done” clears it.
- Empty state: `<div className="dir-empty"><b>Nothing here</b>No suggestions in this view.</div>`.

- [ ] **Step 4: Page wiring (`AssetModels.tsx`)**
  - `const [view, setView] = useState<'all' | 'review' | 'lookup'>('all');`
  - `const [lookupStatus, setLookupStatus] = useState<SpecLookupStatus | null>(null); const [lookupKey, setLookupKey] = useState(0);` + an effect calling `getSpecLookupStatus()` on `[lookupKey]` (ignore errors silently for the badge; 403 users never see the tab anyway).
  - Third tab button after Review, same markup: `Spec lookup{lookupStatus && <>{' '}<span className="badge-count">{lookupStatus.pending_count}</span></>}` (keep the load-bearing space comment's rule).
  - Render `{!error && view === 'lookup' && <SpecLookupPanel canChange={canChange} status={lookupStatus} onChanged={() => { setLookupKey((k) => k + 1); void load(); }} />}` next to the Review panel.
  - `ModelRowDetail` gains props `lookupConfigured: boolean` and `onLookup: () => Promise<void>` and renders, inside `detail-actions` when `canEdit`:

```tsx
<button className="mini-btn" disabled={!lookupConfigured || model.private || model.spec_lookup_skip}
        title={model.private ? 'Private models are never sent to Claude.'
          : model.spec_lookup_skip ? 'Spec lookup is skipped for this model.'
          : !lookupConfigured ? 'No Anthropic API key is configured.' : undefined}
        onClick={() => void onLookup()}>Look up specs</button>
```

    and a line under the Specifications `dl`: `<p className="page-hint">Last looked up {model.specs_looked_up_at ? <date> : 'never'}{model.private ? ' · Private' : ''}</p>`.
  - The page's `onLookup` for a model: `await queueSpecLookup([m.id]); toast(...)` using the existing `useToast()` (check its call shape in the file), then `setLookupKey(k+1)`.

- [ ] **Step 5: Edit form** — `lib/assets.ts`: `ModelFormState` gains `private: boolean; spec_lookup_skip: boolean;`; `formFromModel` sets `private: m?.private ?? false, spec_lookup_skip: m?.spec_lookup_skip ?? false`; `modelPayload` adds

```ts
  if (form.private !== Boolean(orig('private'))) out.private = form.private;
  if (form.spec_lookup_skip !== Boolean(orig('spec_lookup_skip'))) out.spec_lookup_skip = form.spec_lookup_skip;
```

  (for create, `original === null` so `orig()` is null → only `true` values are sent). In `ModelEditModal.tsx`, after the "Field knowledge" section add a `modal-section` "Spec lookup" with two rows using the shared `Switch`:
  - **Private** — "Never sent to Claude for spec lookup."
  - **Skip spec lookup** — "Background search ignores this model (for placeholders and junk entries)."
  `setField` currently takes strings — add a boolean setter or widen it; keep the form's existing idiom. Update `lib/assets.test.ts` (`modelPayload` cases) with one test each: toggling private sends `{ private: true }`; unchanged flags send nothing.

- [ ] **Step 6: Run** `npx vitest run src/components/assets src/pages/AssetModels src/lib/assets` and `npx tsc --noEmit -p .`, plus the list-typography guardrail `npx vitest run src/styles` — expect PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(portal): Makes / Models Spec lookup tab, Look up specs action, Private / Skip switches"`

---

### Task 11: Portal — Developer › System Config › Spec lookup tab

**Files:**
- Create: `portal/src/components/system/SpecLookupTab.tsx`
- Create: `portal/src/components/system/SpecLookupTab.test.tsx`
- Modify: `portal/src/pages/SystemConfig.tsx` (TABS)

**Interfaces:**
- Consumes: `getSpecLookupDev`, `testSpecLookup` (Task 9).

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../lib/api';
import SpecLookupTab from './SpecLookupTab';

const DEV: api.SpecLookupDev = { model: 'claude-sonnet-5', max_searches: 4, max_fetches: 3,
  key_set: true, key_last4: 'a1b2', worker_status: 'running', worker_heartbeat_at: null };

describe('SpecLookupTab', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(api, 'getSpecLookupDev').mockResolvedValue(DEV); });

  it('shows config with the key masked', async () => {
    render(<SpecLookupTab />);
    expect(await screen.findByText('claude-sonnet-5')).toBeInTheDocument();
    expect(screen.getByText('Set (…a1b2)')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('says not set and still allows a test', async () => {
    vi.spyOn(api, 'getSpecLookupDev').mockResolvedValue({ ...DEV, key_set: false, key_last4: null });
    vi.spyOn(api, 'testSpecLookup').mockResolvedValue({ ok: false, latency_ms: null, error: 'not_configured' });
    render(<SpecLookupTab />);
    expect(await screen.findByText('Not set')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/not_configured/)).toBeInTheDocument();
  });

  it('reports a successful test with latency', async () => {
    vi.spyOn(api, 'testSpecLookup').mockResolvedValue({ ok: true, latency_ms: 812, error: null });
    render(<SpecLookupTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(/Connected in 812 ms/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — read `components/system/LoggingTab.tsx` first and copy its outer markup/classes (the sysconf tab body idiom). Content: a `dl.kv` with Model, Max searches per model, Max page reads per model, API key (`key_set ? `Set (…${key_last4 ?? '????'})` : 'Not set'`), Worker (`worker_status`, plus heartbeat time if present); a hint paragraph: "Set these in the Environment tab (SS_ANTHROPIC_API_KEY, SS_SPEC_LOOKUP_*); the API and worker pick up changes after a restart."; a `mini-btn` **Test connection** → `testSpecLookup()` → `Connected in {latency_ms} ms` in `set-ok` or the error in `pf-error`.

In `SystemConfig.tsx` TABS add `{ key: 'spec-lookup', label: 'Spec lookup', component: SpecLookupTab }` after Environment.

- [ ] **Step 4: Run** the new test + `npx vitest run src/pages/SystemConfig src/components/system` + `npx tsc --noEmit -p .` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(portal): Developer › System Config › Spec lookup tab (masked key, worker health, test connection)"`

---

### Task 12: Full suites + live verification (controller, not a subagent)

- [ ] **Step 1: Full API suite** (foreground, ~17+ min): `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_spec_lookup .venv/bin/pytest -q -x -p no:cacheprovider` — all green. Full portal suite: `cd portal && npx vitest run` and `npx tsc --noEmit -p .` — green (the known order-dependent ClientDashboard flake may appear; re-run it in isolation).

- [ ] **Step 2: Live DB.** The dev DB is at 0079 (wiki branch migrations), so this branch can't migrate it directly. Clone it:

```bash
docker exec serversherpa-dev-postgres-1 createdb -U serversherpa -T serversherpa serversherpa_speclookup_live
docker exec serversherpa-dev-postgres-1 psql -U serversherpa -d serversherpa_speclookup_live -c "UPDATE alembic_version SET version_num='0073'"
cd api && SS_DATABASE_URL=postgresql+asyncpg://serversherpa:<pw>@localhost:5433/serversherpa_speclookup_live PYTHONPATH=$PWD/src .venv/bin/alembic upgrade head
```

(`createdb -T` needs no other connections to the template DB — if the dev stack is running, use `pg_dump | psql` into a fresh DB instead.) Run the worktree API/worker/portal against that DB on spare ports (API 8001, portal 5175 — see memory "User detail page" live-verify recipe).

- [ ] **Step 3: Key.** Jimmy puts a real key in `SS_ANTHROPIC_API_KEY` (worktree `.env`, or via Developer › System Config › Environment). Never type a key yourself.

- [ ] **Step 4: Sample run.** Queue ~10 models via the per-model button: HPE DL320 Gen11 8 SFF, IBM Power 750 (8408-E8D), VeloCloud SD-WAN Edge 3800, Dell Isilon H5600, DellEMC Unity XT 680F DPE, Pure Storage FlashArray //X20 R2 3U, plus junk (Pure Storage controller 0, Generic_Storage Peripheral 2U). Run `serversherpa spec-lookup-worker --once` repeatedly (or the reload worker). Record per model: suggestions found, which were verified, tokens, searches, est. cost. Check the Spec lookup tab renders them with working source links, approve one, undo it, and confirm audit rows (`spec_lookup.apply` / `spec_lookup.undo`).

- [ ] **Step 5: Report** real cost per model and hit rate to Jimmy before anyone runs Find missing specs on the whole catalog; drop the clone DB afterwards (`dropdb serversherpa_speclookup_live`).

- [ ] **Step 6: Finish** via superpowers:finishing-a-development-branch (Jimmy decides merge/push). Update memory with a `model-spec-lookup` entry and the parity sheet if a row applies (read `.claude/parity-sheet.md` first).
