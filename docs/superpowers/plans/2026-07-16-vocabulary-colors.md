# Vocabulary colours + create — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vocabulary colours become free-picked hex that stay readable in both themes, and site types / worker levels gain colour plus create.

**Architecture:** One hex per value; lightness clamps per theme at render via `oklch(from …)`, preserving hue. Chips clamp their *text* (colour on a tint of itself); level badges clamp their *background* (fixed near-black text sits on it). A new worker level is created by position (`after: "L2"`), not by rank — the server computes the rank and shifts, using a now-deferrable unique constraint.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 async, Alembic, Postgres 16; React 18 + TypeScript + Vite, vitest (jsdom now available).

**Spec:** `docs/superpowers/specs/2026-07-16-vocabulary-colors-design.md`
**Base:** branch `vocabulary-colors` off `main` @ `fab77b7` (status-values + worker vocab + testability all merged). Baseline: **API 246**, **portal 108**, typecheck clean.

## Global Constraints

- Colours are hex `#rrggbb`, validated `^#[0-9a-fA-F]{6}$` and stored lowercase. This is a deliberate deviation from the status-values spec (which said don't validate) — colour was a token from a fixed `<select>` then, it is free input now.
- **The seven tokens and their `.chip.c-*` classes stay.** They back hardcoded UI chips that are not vocabulary (org kinds, the active/inactive flag, the access matrix). Only values stored in a table become hex.
- Error bodies are `{"detail": {"code": "..."}}` via each router's local `_err(status, code)`. Never a bare `HTTPException`.
- Null-guard idiom, non-negotiable and burnt four times on the last branch: a `NON_NULLABLE_*_FIELDS` pre-check that 422s an explicit null, **then an unguarded setattr loop**. The predicate is `is None`, never falsy — `sort_order: 0` and `is_active: false` and `expected_skills: []` are all legitimate. `routes/status_values.py::update_status_value` is the reference.
- `key`/`level`/`record_type` are never renameable. `worker_profiles.level` and `sites.site_type` are FK targets.
- Mutations that change data write an audit row via `audit(db, actor_id=…, entity_type=…, entity_id=…, action=…, changes=…)` with `snapshot()`/`diff()`, guarded by `if changes:`.
- Portal: pure/testable logic lives in `lib/variables.ts` with `lib/variables.test.ts` beside it. Components call `lib/api.ts` from `useEffect` into `useState`; no React Query.
- Run API tests from `api/` with `.venv/bin/pytest`. Portal from `portal/` with `npm test`. There is no lint script in this repo.

---

### Task 1: Migration 0013 — hex, colour columns, deferrable rank

**Files:**
- Create: `api/migrations/versions/0013_vocabulary_colors.py`
- Modify: `api/src/serversherpa/db/models.py` — add `color` to `SiteType` and `WorkerLevel`
- Modify: `api/src/serversherpa/status/labels.py` — `UNKNOWN_COLOR`
- Modify: `api/tests/conftest.py` — the three seed-restore blocks
- Test: `api/tests/test_vocabulary_colors_model.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `SiteType.color`, `WorkerLevel.color` (both `Mapped[str]`); `status_values.color` holding hex; `worker_levels_rank_key` deferrable.

**Context:** `worker_levels.rank`'s constraint is `worker_levels_rank_key`, `UNIQUE (rank)`, non-deferrable (verified against the live DB). `SiteLookupOut.color` already exists and currently serialises `null` forever — after this it carries a real value.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_vocabulary_colors_model.py
"""0013: vocabulary colours are hex, and rank can be shifted in one statement."""

import re

from sqlalchemy import select, text

from serversherpa.db.models import SiteType, StatusValue, WorkerLevel

HEX = re.compile(r"^#[0-9a-f]{6}$")


async def test_every_status_value_color_is_hex(db):
    rows = (await db.scalars(select(StatusValue))).all()
    assert rows
    for r in rows:
        assert HEX.match(r.color), f"{r.record_type}:{r.key} -> {r.color}"


async def test_status_tokens_mapped_to_their_light_hex(db):
    """Light is the source: it preserves today's light-mode appearance exactly."""
    rows = {(r.record_type, r.key): r.color
            for r in await db.scalars(select(StatusValue))}
    assert rows[("site", "active")] == "#178a4c"          # was c-green
    assert rows[("site", "planned")] == "#0f7c86"         # was c-aqua
    assert rows[("site", "inactive")] == "#51606f"        # was c-slate
    assert rows[("site", "decommissioned")] == "#c03540"  # was c-red
    assert rows[("worker", "standby")] == "#a36207"       # was c-amber


async def test_site_types_seeded_with_hex(db):
    rows = {r.key: r.color for r in await db.scalars(select(SiteType))}
    assert rows["datacenter"] == "#1668a7"
    assert all(HEX.match(c) for c in rows.values())


async def test_worker_levels_keep_their_existing_badge_colors(db):
    """Seeded from the LEVEL_COLORS map being deleted, so badges look identical."""
    rows = {r.level: r.color for r in await db.scalars(select(WorkerLevel))}
    assert rows == {"L1": "#8a93a6", "L2": "#4dd0ff", "L3": "#35e0c8",
                    "L4": "#3ddc84", "L5": "#a78bfa", "L6": "#ffb84d"}


async def test_rank_constraint_is_deferrable_but_not_initially_deferred(db):
    """Both halves matter. DEFERRABLE moves the check per-row -> end-of-statement,
    which is what lets the shift run. INITIALLY IMMEDIATE keeps a real violation
    attributable to its own statement instead of surfacing at COMMIT — and
    condeferrable reads true under BOTH settings, so asserting it alone would
    sail past a schema that silently deferred every rank check application-wide."""
    row = (await db.execute(text(
        "SELECT condeferrable, condeferred FROM pg_constraint "
        "WHERE conname = 'worker_levels_rank_key'"))).one()
    assert row.condeferrable is True
    assert row.condeferred is False


async def test_rank_shift_lands_in_one_statement(db):
    """The property the create endpoint depends on: a bare UPDATE shifting a
    contiguous suffix succeeds. Against a NON-deferrable constraint this raises
    a duplicate-key error on the UPDATE itself (ascending row order sets 3 -> 4
    while a row still holds 4). No SET CONSTRAINTS — deferrable already means
    end-of-statement checking, and adding it would only pin that the constraint
    is deferrable, which the test above already does."""
    await db.execute(text("UPDATE worker_levels SET rank = rank + 1 WHERE rank >= 3"))
    ranks = [r.rank for r in await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))]
    assert ranks == [1, 2, 4, 5, 6, 7]
    await db.rollback()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_model.py -v`
Expected: FAIL — `AttributeError` / no `color` on `SiteType`.

- [ ] **Step 3a: Write the migration**

```python
# api/migrations/versions/0013_vocabulary_colors.py
"""Vocabulary colours become hex; site types and levels gain one; rank defers.

The seven tokens each carried a *different value per theme* — light values are
dark colours, dark values are bright. A single stored hex only works because
render-time clamps lightness per theme (see the spec). Light is the source:
it preserves today's light-mode appearance byte-for-byte.

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# token -> light-theme hex (directory.css :root)
TOKEN_HEX = {
    "c-green": "#178a4c", "c-amber": "#a36207", "c-red": "#c03540",
    "c-blue": "#1668a7", "c-violet": "#6d4fc4", "c-aqua": "#0f7c86",
    "c-slate": "#51606f",
}
FALLBACK_HEX = "#51606f"   # matches the old UNKNOWN_COLOR = "c-slate"

# no prior colour existed — site types rendered permanently grey
SITE_TYPE_HEX = {
    "datacenter": "#1668a7", "office": "#6d4fc4", "warehouse": "#a36207",
    "colo": "#0f7c86", "partner_office": "#178a4c", "other": "#51606f",
}

# lifted verbatim from LEVEL_COLORS in portal/src/pages/Workers.tsx, which this
# migration's landing deletes — badges must look identical afterwards
LEVEL_HEX = {
    "L1": "#8a93a6", "L2": "#4dd0ff", "L3": "#35e0c8",
    "L4": "#3ddc84", "L5": "#a78bfa", "L6": "#ffb84d",
}


def _case(mapping: dict[str, str], col: str, fallback: str) -> str:
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in mapping.items())
    return f"CASE {col} {whens} ELSE '{fallback}' END"


def upgrade() -> None:
    op.execute(f"UPDATE status_values SET color = {_case(TOKEN_HEX, 'color', FALLBACK_HEX)}")

    # add nullable -> backfill -> NOT NULL: no lingering server_default, matching
    # status_values.color (the create endpoints always supply a colour)
    for table, mapping, key in (("site_types", SITE_TYPE_HEX, "key"),
                                ("worker_levels", LEVEL_HEX, "level")):
        op.add_column(table, sa.Column("color", sa.Text, nullable=True))
        op.execute(f"UPDATE {table} SET color = {_case(mapping, key, FALLBACK_HEX)}")
        op.alter_column(table, "color", nullable=False)

    # A NON-deferrable unique constraint is checked per row, so a single
    # `UPDATE ... SET rank = rank + 1 WHERE rank >= n` can collide mid-statement
    # depending on row order. Declaring it DEFERRABLE moves the check to
    # end-of-statement — that, not INITIALLY DEFERRED, is what makes the shift
    # work; INITIALLY IMMEDIATE keeps errors attributable to their statement.
    op.drop_constraint("worker_levels_rank_key", "worker_levels", type_="unique")
    op.create_unique_constraint(
        "worker_levels_rank_key", "worker_levels", ["rank"], deferrable=True,
        initially="IMMEDIATE")


def downgrade() -> None:
    # LOSSY, deliberately. A token vocabulary cannot represent an arbitrary
    # colour: the seven known hexes reverse-map, and everything a user picked
    # after 0013 collapses to c-slate. There is no honest nearest-match — a
    # colour-distance function would invent a wrong answer rather than admit
    # the loss. site_types.color and worker_levels.color are dropped outright.
    reverse = {v: k for k, v in TOKEN_HEX.items()}
    op.execute(f"UPDATE status_values SET color = {_case(reverse, 'color', 'c-slate')}")

    op.drop_constraint("worker_levels_rank_key", "worker_levels", type_="unique")
    op.create_unique_constraint("worker_levels_rank_key", "worker_levels", ["rank"])

    op.drop_column("worker_levels", "color")
    op.drop_column("site_types", "color")
```

- [ ] **Step 3b: Update the models**

In `api/src/serversherpa/db/models.py`, add to `SiteType` (after `icon`) and to `WorkerLevel` (after `expected_skills`):

```python
    color: Mapped[str]
```

- [ ] **Step 3c: Update `UNKNOWN_COLOR`**

In `api/src/serversherpa/status/labels.py`, the constant is now a hex. Keep the comment explaining it is unreachable (the composite FK guarantees a row exists) — only the value changes:

```python
UNKNOWN_COLOR = "#51606f"
```

- [ ] **Step 3d: Fix the test harness**

`conftest.clean_db` restores seed rows for all three tables and must now restore `color` too, or an edit test pollutes later runs. In `api/tests/conftest.py`:

- The `status_values` UPDATE (~line 84): change each `VALUES` row's colour from the token to its hex per `TOKEN_HEX` above, and add `color = v.color` if the SET list does not already carry it (it does — verify).
- The `site_types` UPDATE (~line 99): add `color` to the `SET` list, to the `VALUES` rows (per `SITE_TYPE_HEX`), and to the `AS v(...)` column list.
- The `worker_levels` UPDATE (~line 64): same — add `color` per `LEVEL_HEX`.

Also: `worker_levels` needs the same **delete-customs-then-restore** treatment `status_values` already has (~line 77), because Task 4 adds `POST /worker-levels` and a created level would otherwise leak into every later test:

```python
        await session.execute(text(
            "DELETE FROM worker_levels WHERE level NOT IN "
            "('L1','L2','L3','L4','L5','L6')"))
```

Place it **before** the `worker_levels` UPDATE. Same for `site_types` (Task 3 adds create):

```python
        await session.execute(text(
            "DELETE FROM site_types WHERE key NOT IN ('datacenter','office',"
            "'warehouse','colo','partner_office','other')"))
```

`sites` is TRUNCATEd above, so no FK blocks the site_types delete. `worker_profiles` cascades from `people`, so none blocks the levels delete. **Verify both claims** before relying on them.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_model.py -v`
Expected: 6 passed.

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: 246 + 6 = 252 passed, 0 failures. If anything else fails, it is a real regression — fix it, do not adjust the test.

- [ ] **Step 5: Verify the downgrade round-trip on a POPULATED throwaway DB**

The dev DB has zero sites, so a round-trip there proves little. Do it properly:

```bash
createdb -h 127.0.0.1 -p 5433 -U <user> serversherpa_migtest13
SS_DATABASE_URL=<...serversherpa_migtest13> .venv/bin/alembic upgrade 0012
# insert a site on a non-default status + a worker profile, via SQL
SS_DATABASE_URL=<...> .venv/bin/alembic upgrade head      # colours become hex
SS_DATABASE_URL=<...> .venv/bin/alembic downgrade 0012    # hex back to tokens
SS_DATABASE_URL=<...> .venv/bin/alembic upgrade head
dropdb -h 127.0.0.1 -p 5433 -U <user> serversherpa_migtest13
```
Read `api/.env` for host/port/user/password (Postgres is Docker on `127.0.0.1:5433`). Export `PGPASSWORD` rather than inlining it. **Always dropdb, even on failure.** Paste every command and its output into the report.

- [ ] **Step 6: Commit**

```bash
git add api/migrations/versions/0013_vocabulary_colors.py api/src/serversherpa/db/models.py api/src/serversherpa/status/labels.py api/tests/conftest.py api/tests/test_vocabulary_colors_model.py
git commit -m "Vocabulary colours become hex; site types and levels gain one"
```

---

### Task 2: Colour on the two lookups + the shared hex type

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`
- Modify: `api/src/serversherpa/api/routes/sites.py` — `update_site_type`
- Modify: `api/src/serversherpa/api/routes/workers.py` — `update_level`
- Test: `api/tests/test_vocabulary_colors_api.py`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `HexColor` annotated type; `SiteLookupUpdateIn.color`; `WorkerLevelOut.color`, `WorkerLevelUpdateIn.color`.

**Context:** `SiteLookupOut.color` already exists (`str | None`) and has been serialising `null` forever — it now carries a value, no change needed. `SiteLookupUpdateIn` carries a comment saying `color` was removed as vestigial and that "adding a field back that the handler doesn't write is how you get a silent no-op." That comment was correct then and is wrong now — `site_types.color` exists and the handler will write it. **Rewrite the comment; do not just delete it.**

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_vocabulary_colors_api.py
"""Colour is now free-picked hex, so the format is validated — the one thing
the status-values spec deliberately did not do, back when it was a token from
a fixed <select>."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _dev(db, client, email="dev@test.example.com"):
    p = Person(first_name="D", last_name="Ev", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="developer"))
    await db.commit()
    return await login(client, email=email)


async def test_site_type_color_is_editable(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"color": "#ff5733"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#ff5733"
    types = (await client.get("/site-types", headers=hdrs)).json()
    assert next(t for t in types if t["key"] == "datacenter")["color"] == "#ff5733"


async def test_worker_level_color_is_editable(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"color": "#ff5733"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#ff5733"


async def test_uppercase_hex_is_normalised(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/site-types/office", headers=hdrs,
                              json={"color": "#AABBCC"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#aabbcc"


async def test_a_token_is_no_longer_a_valid_colour(client, db, seeded_user):
    """The old format must be rejected, or a stale client silently writes junk
    into a CSS custom property."""
    hdrs = await _dev(db, client)
    for body in ({"color": "c-green"}, {"color": "#ggg"}, {"color": "red"},
                 {"color": "#12345"}):
        resp = await client.patch("/site-types/office", headers=hdrs, json=body)
        assert resp.status_code == 422, body


async def test_status_value_colour_validates_too(client, db, seeded_user):
    hdrs = await _dev(db, client)
    assert (await client.patch("/status-values/site/active", headers=hdrs,
                               json={"color": "c-green"})).status_code == 422
    assert (await client.patch("/status-values/site/active", headers=hdrs,
                               json={"color": "#123abc"})).status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_api.py -v`
Expected: FAIL — `color` is not accepted by `SiteLookupUpdateIn` / `WorkerLevelUpdateIn`.

- [ ] **Step 3a: Add the shared type**

In `api/src/serversherpa/api/schemas.py`, near the top (after the existing imports; add `Annotated` and `AfterValidator` as needed):

```python
def _lower(v: str) -> str:
    return v.lower()


# Vocabulary colours are free-picked and land in a CSS custom property, so the
# format is checked — the status-values spec skipped this when colour was a
# token from a fixed <select>. Case-insensitive in, lowercase out, so equality
# and diffing are stable.
HexColor = Annotated[
    str,
    Field(pattern=r"^#[0-9a-fA-F]{6}$"),
    AfterValidator(_lower),
]
```

Then use `HexColor` for the colour field on **every** vocabulary schema:
- `StatusValueCreateIn.color` — replaces `str = Field(min_length=1)`
- `StatusValueUpdateIn.color` — becomes `HexColor | None = None`
- `SiteLookupUpdateIn.color` — **added back**, `HexColor | None = None`
- `WorkerLevelOut.color` — `str` (output, no validation needed)
- `WorkerLevelUpdateIn.color` — `HexColor | None = None`

Rewrite `SiteLookupUpdateIn`'s comment to say what is now true:

```python
class SiteLookupUpdateIn(BaseModel):
    # Fields mirror update_site_type's mutable set exactly — a field the handler
    # does not write is how you get a silent no-op. `color` was removed in
    # ae198dd when 0012 folded site_statuses into status_values and left this
    # schema's colour vestigial; 0013 gave site_types its own colour column, so
    # it is real again and the handler writes it.
    label: str | None = None
    description: str | None = None
    sort_order: int | None = None
    icon: str | None = None
    color: HexColor | None = None
```

- [ ] **Step 3b: Wire the handlers**

`routes/sites.py::update_site_type` — add `"color"` to its `fields` list (line ~174) and to `NON_NULLABLE_SITE_TYPE_FIELDS` (line 149, currently `("label", "description", "sort_order")`). `icon` stays nullable and correctly out of that list.

`routes/workers.py::update_level` — add `"color"` to its fields list and to `NON_NULLABLE_WORKER_LEVEL_FIELDS` (line 322, currently `("title", "description", "expected_skills")`).

Both already use the pre-check + unguarded-loop idiom from the last branch. Do not reintroduce an in-loop `value is not None` guard.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_api.py -v`
Expected: 5 passed.

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: all pass. **Watch for pre-existing tests that PATCH a colour as a token** — e.g. `test_sites_lookups.py` may patch `{"color": "c-blue"}`, which is now a 422. Those assertions encode the old format and must be updated to hex. That is a real behaviour change, not a broken test.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/sites.py api/src/serversherpa/api/routes/workers.py api/tests/
git commit -m "Validate vocabulary colour as hex; site types and levels carry one"
```

---

### Task 3: `POST /site-types`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` — `SiteTypeCreateIn`
- Modify: `api/src/serversherpa/api/routes/sites.py` — `create_site_type`
- Test: `api/tests/test_vocabulary_colors_api.py` (append)

**Interfaces:**
- Consumes: `HexColor` (Task 2).
- Produces: `SiteTypeCreateIn`; `POST /site-types` → 201 `SiteLookupOut`.

**Context:** Mirror `routes/status_values.py::create_status_value` — read it first. Same gate (`devtools:add`), same 409-on-duplicate shape, same audit call.

- [ ] **Step 1: Write the failing test**

```python
async def test_developer_creates_a_site_type(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "hospital", "label": "Hospital", "description": "Clinical site.",
        "sort_order": 7, "icon": "cross", "color": "#c03540",
    })
    assert resp.status_code == 201
    assert resp.json()["key"] == "hospital"

    types = (await client.get("/site-types", headers=hdrs)).json()
    assert any(t["key"] == "hospital" for t in types)


async def test_created_site_type_is_usable_on_a_site(client, db, seeded_user):
    """A type that can't be assigned is a type that doesn't exist."""
    hdrs = await _dev(db, client)
    await client.post("/site-types", headers=hdrs, json={
        "key": "hospital", "label": "Hospital", "color": "#c03540"})
    staff = await login(client)
    resp = await client.post("/sites", headers=staff, json={
        "name": "Mercy General", "site_type": "hospital"})
    assert resp.status_code == 201


async def test_duplicate_site_type_key_is_409(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "datacenter", "label": "Dupe", "color": "#178a4c"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "site_type_exists"


async def test_admin_cannot_create_a_site_type(client, db, seeded_user):
    """Vocabulary is developer-only — the rule the whole design turns on."""
    p = Person(first_name="A", last_name="Admin", email="ada@test.example.com")
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email="ada@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    hdrs = await login(client, email="ada@test.example.com")
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "sneaky", "label": "Sneaky", "color": "#178a4c"})
    assert resp.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_api.py -k site_type -v`
Expected: FAIL — 405 Method Not Allowed on POST.

- [ ] **Step 3: Implement**

Schema, mirroring `StatusValueCreateIn`:

```python
class SiteTypeCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # slug, not prose — this is a stable identifier and an FK target
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1)
    description: str = ""
    sort_order: int = 0
    icon: str | None = None
    color: HexColor
```

Handler in `routes/sites.py`, on `lookups_router`, mirroring `create_status_value`: `require_permission("devtools", "add")`, `db.get(SiteType, body.key)` → 409 `site_type_exists` if present, construct, `audit(..., entity_type="site_type", entity_id=key, action="create", changes=diff({}, snapshot(row, fields)))`, commit, return 201.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_vocabulary_colors_api.py -v`
Expected: all pass.

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/sites.py api/tests/test_vocabulary_colors_api.py
git commit -m "Create site types"
```

---

### Task 4: `POST /worker-levels` — insert by position, shift the rest

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` — `WorkerLevelCreateIn`
- Modify: `api/src/serversherpa/api/routes/workers.py` — `create_level`
- Test: `api/tests/test_worker_level_create.py`

**Interfaces:**
- Consumes: Task 1's deferrable constraint; `HexColor`.
- Produces: `WorkerLevelCreateIn`; `POST /worker-levels` → 201 `WorkerLevelOut`.

**Context — this is the task with real logic in it.** The client sends a *position*, not a rank: `after` names the level to insert after, `null` means first. The server computes the rank. That is deliberate — no client-side rank arithmetic, and a stale client list cannot produce a wrong rank.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_worker_level_create.py
"""A new level is created by position, not by rank number. The shift is the
part that can silently corrupt the scale, so it is what these tests pin."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount, WorkerLevel
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _dev(db, client, email="dev@test.example.com"):
    p = Person(first_name="D", last_name="Ev", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="developer"))
    await db.commit()
    return await login(client, email=email)


async def _scale(db) -> list[tuple[str, int]]:
    return [(r.level, r.rank) for r in await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))]


async def test_insert_after_a_middle_level_shifts_the_rest(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L2B", "after": "L2", "title": "Tech I+",
        "description": "Between.", "expected_skills": [], "color": "#4dd0ff"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 3

    # the WHOLE scale, not just the new row — a broken shift leaves a gap or a
    # duplicate that asserting one rank would miss entirely
    assert await _scale(db) == [
        ("L1", 1), ("L2", 2), ("L2B", 3), ("L3", 4),
        ("L4", 5), ("L5", 6), ("L6", 7)]


async def test_insert_first_shifts_everything(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L0", "after": None, "title": "Trainee",
        "description": "", "expected_skills": [], "color": "#8a93a6"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 1
    assert await _scale(db) == [
        ("L0", 1), ("L1", 2), ("L2", 3), ("L3", 4),
        ("L4", 5), ("L5", 6), ("L6", 7)]


async def test_insert_after_the_last_level_appends(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L7", "after": "L6", "title": "Principal",
        "description": "", "expected_skills": [], "color": "#ffb84d"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 7
    assert await _scale(db) == [
        ("L1", 1), ("L2", 2), ("L3", 3), ("L4", 4),
        ("L5", 5), ("L6", 6), ("L7", 7)]


async def test_unknown_after_is_422(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "LX", "after": "nope", "title": "X",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_level"


async def test_duplicate_level_key_is_409(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L3", "after": "L1", "title": "Dupe",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "worker_level_exists"


async def test_created_level_is_assignable_to_a_worker(client, db, seeded_user):
    """A level that can't be assigned is a level that doesn't exist."""
    hdrs = await _dev(db, client)
    await client.post("/worker-levels", headers=hdrs, json={
        "level": "L7", "after": "L6", "title": "Principal",
        "description": "", "expected_skills": [], "color": "#ffb84d"})
    staff = await login(client)
    person = Person(first_name="W", last_name="Kr")
    db.add(person)
    await db.commit()
    resp = await client.put(f"/workers/{person.id}/profile", headers=staff,
                            json={"level": "L7", "status": "active"})
    assert resp.status_code in (200, 204)


async def test_admin_cannot_create_a_level(client, db, seeded_user):
    p = Person(first_name="A", last_name="Admin", email="ada@test.example.com")
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email="ada@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    hdrs = await login(client, email="ada@test.example.com")
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "LX", "after": "L6", "title": "X",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_worker_level_create.py -v`
Expected: FAIL — 405 Method Not Allowed.

- [ ] **Step 3: Implement**

Schema:

```python
class WorkerLevelCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: str = Field(min_length=1, max_length=10)
    title: str = Field(min_length=1)
    description: str = ""
    expected_skills: list[str] = []
    color: HexColor
    # A POSITION, not a rank: names the level to insert after; None = first.
    # Required-but-nullable on purpose — the server computes the rank, so no
    # client-side arithmetic and a stale client list can't produce a wrong one.
    after: str | None
```

Handler in `routes/workers.py`, on `levels_router`, `require_permission("devtools", "add")`:

```python
    if await db.get(WorkerLevel, body.level) is not None:
        raise _err(409, "worker_level_exists")

    if body.after is None:
        new_rank = 1
    else:
        anchor = await db.get(WorkerLevel, body.after)
        if anchor is None:
            raise _err(422, "unknown_level")
        new_rank = anchor.rank + 1

    # Safe as one statement because worker_levels_rank_key is DEFERRABLE, which
    # moves its uniqueness check from per-row to end-of-statement — the final
    # state is unique, the transient one is never checked. INITIALLY IMMEDIATE
    # keeps a real violation attributable to this statement rather than COMMIT.
    # No SET CONSTRAINTS: it is redundant here and would only cost attribution.
    await db.execute(
        update(WorkerLevel)
        .where(WorkerLevel.rank >= new_rank)
        .values(rank=WorkerLevel.rank + 1))

    row = WorkerLevel(level=body.level, rank=new_rank, title=body.title,
                      description=body.description,
                      expected_skills=body.expected_skills, color=body.color,
                      updated_at=datetime.now(UTC))
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="worker_level",
          entity_id=body.level, action="create",
          changes=diff({}, snapshot(row, LEVEL_FIELDS)))
    await db.commit()
    return WorkerLevelOut.model_validate(row)
```

Note `after` naming the last level needs no special case: `new_rank = max + 1`, and the `WHERE rank >= new_rank` shift matches zero rows.

Add `from sqlalchemy import text, update` and `from datetime import UTC, datetime` if absent. `LEVEL_FIELDS` = the mutable list used by `update_level` plus `rank`/`level` for the create snapshot — read that handler and stay consistent.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_worker_level_create.py -v`
Expected: 7 passed.

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 5: Prove the deferral is load-bearing**

Temporarily make 0013's constraint non-deferrable (plain `create_unique_constraint` with no `deferrable=`), **drop the test DB so conftest rebuilds it** — `alembic upgrade head` against a DB already at head silently re-tests the old schema, which is the trap that invalidates most attempts at this — and run `test_insert_after_a_middle_level_shifts_the_rest`. It must FAIL with a duplicate-key violation attributed to the UPDATE statement itself. Restore, rebuild, confirm green. Paste both runs.

This ablation targets the constraint's *declaration*, not a `SET CONSTRAINTS` call — the declaration is what does the work. A deferrable constraint nobody has seen fail without is not yet known to be necessary.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/workers.py api/tests/test_worker_level_create.py
git commit -m "Create worker levels by position, shifting the scale"
```

---

### Task 5: Portal client + pure helpers

**Files:**
- Modify: `portal/src/lib/api.ts`
- Modify: `portal/src/lib/variables.ts`
- Test: `portal/src/lib/variables.test.ts`

**Interfaces:**
- Consumes: Tasks 2-4's endpoints.
- Produces: `createSiteType(body)`, `createWorkerLevel(body)`; `SiteLookup.color` (already present), `WorkerLevel.color`; and in `lib/variables.ts`: `PRESET_COLORS`, `normalizeHex(input)`, `isHex(input)`, `insertionPoints(levels)`, `rankAfter(levels, after)`.

**Context:** every `api.ts` function is the same four lines — `apiFetch`, `if (!resp.ok) throw await errorFrom(resp)`, `return resp.json()`. Match `createStatusValue`.

- [ ] **Step 1: Write the failing test**

```ts
// append to portal/src/lib/variables.test.ts
import {
  PRESET_COLORS, insertionPoints, isHex, normalizeHex, rankAfter,
} from './variables';

const LEVELS = [
  { level: 'L1', rank: 1, title: 'Apprentice', description: '', expected_skills: [], color: '#8a93a6' },
  { level: 'L2', rank: 2, title: 'Junior', description: '', expected_skills: [], color: '#4dd0ff' },
  { level: 'L3', rank: 3, title: 'Tech', description: '', expected_skills: [], color: '#35e0c8' },
];

describe('normalizeHex', () => {
  it('lowercases so equality and diffing are stable', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc');
  });

  it('adds a missing leading hash — pasted brand colours often lack it', () => {
    expect(normalizeHex('aabbcc')).toBe('#aabbcc');
  });

  it('expands 3-digit shorthand', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHex('  #AABBCC  ')).toBe('#aabbcc');
  });

  it('returns null for junk rather than guessing', () => {
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#gggggg')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('isHex', () => {
  it('accepts only the canonical stored form', () => {
    expect(isHex('#aabbcc')).toBe(true);
    expect(isHex('#AABBCC')).toBe(false);   // normalise first
    expect(isHex('c-green')).toBe(false);   // the old token format
  });
});

describe('PRESET_COLORS', () => {
  it('offers the seven the palette was built on, all canonical hex', () => {
    expect(PRESET_COLORS).toHaveLength(7);
    for (const p of PRESET_COLORS) expect(isHex(p.value)).toBe(true);
    expect(PRESET_COLORS.map((p) => p.label)).toContain('Green');
  });
});

describe('insertionPoints', () => {
  it('offers a gap before, between each pair, and after — last is default', () => {
    expect(insertionPoints(LEVELS)).toEqual([
      { after: null, label: 'Before L1 (first)' },
      { after: 'L1', label: 'Between L1 and L2' },
      { after: 'L2', label: 'Between L2 and L3' },
      { after: 'L3', label: 'After L3 (last)' },
    ]);
  });

  it('handles a single level — before and after, no between', () => {
    expect(insertionPoints([LEVELS[0]])).toEqual([
      { after: null, label: 'Before L1 (first)' },
      { after: 'L1', label: 'After L1 (last)' },
    ]);
  });

  it('offers one point for an empty scale', () => {
    expect(insertionPoints([])).toEqual([{ after: null, label: 'First level' }]);
  });
});

describe('rankAfter', () => {
  it('is the anchor rank plus one', () => {
    expect(rankAfter(LEVELS, 'L2')).toBe(3);
  });

  it('is 1 for the first position', () => {
    expect(rankAfter(LEVELS, null)).toBe(1);
  });

  it('is 1 for an empty scale', () => {
    expect(rankAfter([], null)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && npm test -- variables`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement**

`lib/variables.ts` additions:

```ts
// The seven the palette was built on. Not a limit any more — a starting point,
// so the common case stays one click. Values are the light-theme hexes; render
// clamps lightness per theme (see the CSS in styles/directory.css).
export const PRESET_COLORS: { value: string; label: string }[] = [
  { value: '#178a4c', label: 'Green' },
  { value: '#a36207', label: 'Amber' },
  { value: '#c03540', label: 'Red' },
  { value: '#1668a7', label: 'Blue' },
  { value: '#6d4fc4', label: 'Violet' },
  { value: '#0f7c86', label: 'Aqua' },
  { value: '#51606f', label: 'Slate' },
];

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isHex(v: string): boolean {
  return HEX_RE.test(v);
}

// Accepts what a person actually pastes; returns the canonical stored form, or
// null rather than guessing at junk.
export function normalizeHex(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return HEX_RE.test(v) ? v : null;
}

export interface InsertionPoint { after: string | null; label: string }

// The gaps ARE the insertion points — "before, between, after" is one list.
export function insertionPoints(levels: WorkerLevel[]): InsertionPoint[] {
  const sorted = [...levels].sort((a, b) => a.rank - b.rank);
  if (!sorted.length) return [{ after: null, label: 'First level' }];
  const out: InsertionPoint[] = [
    { after: null, label: `Before ${sorted[0].level} (first)` },
  ];
  sorted.forEach((l, i) => {
    const next = sorted[i + 1];
    out.push({
      after: l.level,
      label: next ? `Between ${l.level} and ${next.level}`
                  : `After ${l.level} (last)`,
    });
  });
  return out;
}

// Mirrors the server's rule so the preview matches what will be saved.
export function rankAfter(levels: WorkerLevel[], after: string | null): number {
  if (after === null) return 1;
  return (levels.find((l) => l.level === after)?.rank ?? 0) + 1;
}
```

Import `WorkerLevel` as a type from `./api`.

`api.ts`: add `createSiteType(body)` → `POST /site-types` and `createWorkerLevel(body)` → `POST /worker-levels`, both four lines matching `createStatusValue`. Add `color: string` to the `WorkerLevel` interface.

- [ ] **Step 4: Run the tests**

Run: `cd portal && npm test -- variables && npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/variables.ts portal/src/lib/variables.test.ts
git commit -m "Portal: hex helpers, insertion points, create clients"
```

---

### Task 6: The colour rule + `ColorField`

**Files:**
- Modify: `portal/src/styles/directory.css`
- Create: `portal/src/components/variables/ColorField.tsx`
- Test: `portal/src/components/variables/ColorField.test.tsx`

**Interfaces:**
- Consumes: `PRESET_COLORS`, `normalizeHex` (Task 5).
- Produces: `<ColorField value={string} onChange={(hex: string) => void} disabled?={boolean} />`.

**Context:** jsdom is available now (`2026-07-16-portal-component-testability-design.md`), so this component gets a real test. Check how the existing `AppShell.test.tsx` / `SiteEditModal.test.tsx` opt into the jsdom environment and follow it exactly.

- [ ] **Step 1: Write the CSS**

In `portal/src/styles/directory.css`, near the existing `.chip.c-*` rules — which **stay**, they back hardcoded UI chips:

```css
/* ── vocabulary colour ────────────────────────────────────────
   Stored values are free-picked hex. The seven tokens above each carry a
   DIFFERENT value per theme (light values are dark, dark values are bright)
   because chip text must contrast the card. One hex can't do that — so clamp
   lightness per theme and keep hue and chroma exactly as picked. */

@property --chip { syntax: '<color>'; inherits: true; initial-value: #51606f; }
@property --lvl  { syntax: '<color>'; inherits: true; initial-value: #8a93a6; }

.chip.custom {
  color: oklch(from var(--chip) clamp(0.30, l, 0.50) c h);
  background: color-mix(in srgb, var(--chip) 12%, transparent);
  border-color: color-mix(in srgb, var(--chip) 28%, transparent);
}
.portal-shell[data-theme='dark'] .chip.custom {
  color: oklch(from var(--chip) clamp(0.72, l, 0.92) c h);
}

/* The badge is the inverse: the colour is the BACKGROUND and .lvl-badge b's
   near-black text is fixed in both themes, so clamp it bright instead. Every
   current LEVEL_COLORS value already is. */
.lvl-badge b {
  background: oklch(from var(--lvl) clamp(0.70, l, 0.88) c h);
}
```

Remove the now-dead `background` from the existing `.lvl-badge b` block if it hardcodes one, keeping its `color: #0c1117`.

- [ ] **Step 2: Write the failing test**

```tsx
// portal/src/components/variables/ColorField.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ColorField from './ColorField';

describe('ColorField', () => {
  it('emits the preset hex when a swatch is clicked', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /red/i }));
    expect(onChange).toHaveBeenCalledWith('#c03540');
  });

  it('normalises a pasted hex rather than rejecting it', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#AABBCC' } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledWith('#aabbcc');
  });

  it('does not emit junk', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: 'not-a-colour' } });
    fireEvent.blur(text);
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

Match the jsdom opt-in of the existing component tests exactly.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd portal && npm test -- ColorField`
Expected: FAIL — cannot resolve `./ColorField`.

- [ ] **Step 4: Implement**

`ColorField.tsx` renders:
- `<input type="color">` bound to `value` — the real OS picker, zero dependencies.
- A hex text input (labelled "Hex"), normalising through `normalizeHex` on blur; emit only on success, leave the field alone on junk.
- The seven `PRESET_COLORS` as swatch buttons, each with an accessible name (the label) so the test above can find it.
- **A live preview: the chip rendered in BOTH themes side by side.** This is load-bearing — it is what makes "one pick, adapts per theme" honest rather than surprising. Render the dark half inside `<div className="portal-shell" data-theme="dark">` so it picks up the real rule rather than an approximation.

Add the CSS it needs to `directory.css`. Follow the `.pf-form` field conventions of the existing modals.

- [ ] **Step 5: Run the tests**

Run: `cd portal && npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add portal/src/styles/directory.css portal/src/components/variables/ColorField.tsx portal/src/components/variables/ColorField.test.tsx
git commit -m "Portal: theme-adaptive vocabulary colour + the picker"
```

---

### Task 7: Wire the picker and create into the three modals

**Files:**
- Modify: `portal/src/components/variables/StatusEditModal.tsx`
- Modify: `portal/src/components/variables/SiteTypeEditModal.tsx`
- Modify: `portal/src/components/variables/WorkerLevelEditModal.tsx`
- Modify: `portal/src/pages/Variables.tsx`
- Modify: `portal/src/lib/variables.ts` (+ test) — create payloads

**Interfaces:**
- Consumes: `ColorField` (Task 6); `createSiteType`, `createWorkerLevel`, `insertionPoints`, `rankAfter` (Task 5).
- Produces: `+ New site type` and `+ New level` on their tabs.

**Context — read `StatusEditModal.tsx` first; it is the reference for all of this.** It already solves create-vs-edit, the create-mode save trap (`needsStatusCreate`), immutable-key rendering as `.pf-static` text, and the error map. Mirror it; do not invent a second idiom.

- [ ] **Step 1: Replace the colour `<select>` in `StatusEditModal`**

Swap the native colour `<select>` and its `STATUS_COLOR_TOKENS` for `<ColorField>`. Delete the token list and the tinted-`<option>` workaround — a real picker replaces both.

- [ ] **Step 2: Add colour to the other two modals**

`SiteTypeEditModal` and `WorkerLevelEditModal` each gain a `<ColorField>` and carry `color` through their form state and update payloads (`siteTypeUpdatePayload` / `workerLevelUpdatePayload` in `lib/variables.ts` — add `color` to both, with a test for each, mirroring the existing changed-field cases).

- [ ] **Step 3: Create for site types**

`SiteTypeEditModal` gains create mode exactly as `StatusEditModal` has it: `siteType={null}` means create; `key` is editable in create and `.pf-static` text in edit; `needsSiteTypeCreate(original, createdKey)` in `lib/variables.ts` (mirroring `needsStatusCreate`, with tests) decides POST vs PATCH; store the created key immediately on success, before anything else can throw. `+ New site type` on the tab, gated `can('devtools','add')`.

Error map additions: `site_type_exists` → "That key already exists."

- [ ] **Step 4: Create for worker levels — the gap picker**

`WorkerLevelEditModal` gains create mode. In create mode only, it shows:
- `level` (the key) as a text input. **Free text, never renamed** — `worker_profiles.level` points at it.
- A **Position** `<select>` over `insertionPoints(levels)`, defaulting to the last entry.
- **A live preview of the resulting badge order**, built from `rankAfter`. This is where the key-naming consequence becomes visible: type `L7`, choose "Between L2 and L3", and the preview reads `L1 L2 L7 L3 L4` before saving. Show it; do not police it.

**Fix `rankAfter` first — it currently lies in one case.** Review of Task 5 found it diverges from the server: `(levels.find(...)?.rank ?? 0) + 1` silently returns `1` for an anchor that isn't in `levels`, where `create_level` raises 422 `unknown_level` and refuses. So a stale list (anchor deleted between fetch and submit) would render a confident "inserts first" preview and then 422 on save. Change it to return `number | null` — `null` for an unknown anchor — and have the preview render nothing rather than a false order in that case. Add the test Task 5 lacked: an anchor absent from `levels` returns `null`. Also add the `insertionPoints` test Task 5 lacked: pass levels in non-rank order and assert the output is still rank-ordered, so the `.sort()` is actually pinned (delete it today and every existing test still passes).

`rank` is never sent and never editable — the server derives it from `after`. In edit mode `level` and `rank` stay `.pf-static` text.

Error map additions: `worker_level_exists` → "That level key already exists."; `unknown_level` → "That position no longer exists — reopen and try again."

- [ ] **Step 5: Verify**

Run: `cd portal && npx tsc --noEmit && npm test`
Expected: typecheck clean, all pass.

- [ ] **Step 6: Commit**

```bash
git add portal/src/components/variables/ portal/src/pages/Variables.tsx portal/src/lib/variables.ts portal/src/lib/variables.test.ts
git commit -m "Variables: pick any colour, create site types and levels"
```

---

### Task 8: Repoint every consumer of a vocabulary colour

**Files:**
- Modify: `api/src/serversherpa/api/routes/sites.py` — `_item` denormalises `type_color`
- Modify: `api/src/serversherpa/api/schemas.py` — `SiteItem.type_color`
- Modify: `portal/src/pages/Sites.tsx`, `portal/src/pages/Workers.tsx`, `portal/src/pages/OrgDirectory.tsx`, `portal/src/pages/Variables.tsx`
- Modify: `portal/src/lib/api.ts` — `SiteItem.type_color`

**Interfaces:**
- Consumes: Task 6's `.chip.custom`.
- Produces: no new symbols. `LEVEL_COLORS` is **deleted**.

**Context:** these all currently pass a token where a CSS class is expected — `chip ${status_color}`. With hex that renders `chip #178a4c`, which is not a class, so the chip silently loses its styling. Every one must move to `className="chip custom" style={{ '--chip': color }}`.

- [ ] **Step 1: Find them all**

Run: `cd /Users/jrh1812/Desktop/BaseCampV3 && grep -rn 'chip \${' portal/src/ && grep -rn 'LEVEL_COLORS\|status_color\|type_label' portal/src/ api/src/`

Known: `Sites.tsx:210` (site type, `chip tag` → real colour), `Sites.tsx:214` (status), `Workers.tsx:250`, `Workers.tsx:415`, `Workers.tsx:110` (`LevelBadge`), `OrgDirectory.tsx` (worker status), `Variables.tsx` (the colour column swatch). Work from the grep, not this list.

- [ ] **Step 2: Denormalise `type_color`**

`sites.py::_labels` already builds `types` as `{key: label}`. Widen it to `{key: (label, color)}` — mirroring how `statuses` already carries `(label, color)` — and add `"type_color"` to `_item`'s dict. Add `type_color: str | None` to `SiteItem` (both the Pydantic schema and the TS interface).

`_item`'s existing status fallback `statuses.get(site.status, (site.status, "c-slate"))` must become the hex fallback. `site_type` is nullable, so `type_color` is `str | None`.

- [ ] **Step 3: Repoint the chips**

Each becomes:
```tsx
<span className="chip custom" style={{ '--chip': s.status_color } as CSSProperties}>
```
`LevelBadge` reads `def.color` and sets `--lvl`; **delete `LEVEL_COLORS`**. Its `?? '#8a93a6'` fallback stays for a level not in the fetched list.

Keep every existing `?? fallback` guard — an unknown value must still render, per the last branch's crash.

- [ ] **Step 4: Verify**

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3` — expected all pass; update any test asserting `type_label` shape.
Run: `cd portal && npx tsc --noEmit && npm test` — expected clean and green.

Run: `grep -rn 'chip \${' portal/src/ | grep -v "'chip custom'"` — expected: only non-vocabulary chips (org kinds, login status, tiers) remain, which correctly keep tokens.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/sites.py api/src/serversherpa/api/schemas.py portal/src/lib/api.ts portal/src/pages/
git commit -m "Render vocabulary colours from their stored hex"
```

---

### Task 9: Verification

**Files:** none — this task only observes.

- [ ] **Step 1: Full suites**

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3` — expected: ~265 passed, 0 failed, 0 errors.
Run: `cd portal && npx tsc --noEmit && npm test` — expected: clean, ~125 passed.

- [ ] **Step 2: Apply to the dev DB and restart**

```bash
cd api && .venv/bin/alembic upgrade head
```
Restart the running uvicorn (pid in `/tmp/ss-api.log`) so it loads the new models; a stale process 500s on `SiteType.color`.

- [ ] **Step 3: Hand the browser pass to the plan owner**

STOP. Do not attempt a browser walkthrough — the portal is behind a login and no agent may enter credentials. This is a standing constraint recorded in the progress ledger across three branches.

Report that the branch is code-complete and green, and that these need a human at a logged-in browser:

1. **Pick a colour on each of the three tabs.** Confirm the chip preview matches what renders in the list, and that the dark-theme half of the preview matches reality when you toggle the theme. This is the one thing tests cannot judge.
2. **Pick a deliberately awful colour** — a near-black navy, a pale yellow. Confirm it stays readable in both themes rather than vanishing. That is the whole clamp design, and it is unproven until a human looks.
3. **Create a site type**, then open Sites and confirm it appears in the type picker and renders in its colour.
4. **Create a worker level between two others.** Confirm the position picker preview matched the result, and that the whole scale renumbered correctly on the Workers page.
5. **Level badge**: confirm a created level's badge is legible (bright background, dark text) regardless of the colour picked.
6. Confirm existing chips are unchanged — the migration should be invisible on Sites and Workers.
