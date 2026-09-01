# Labels Site Scoping + Convert-to-Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Templates assignable to one or more sites (empty = global) with an editor selector + list column/facet, and a one-way convert-to-code action that turns a builder template's design into hand-editable raw code.

**Architecture:** Join table `label_template_sites` (FKs both ways, CASCADE) exposed as `site_ids` on the template API; `?site_id=` filter returns assigned + global rows. Convert is a dedicated POST endpoint that compiles the stored design placeholders-mode via the existing compiler dispatch and flips kind/code/design in one transaction. Portal reuses `TagInput` (options mode) for the selector and `listSites()` for names.

**Tech Stack:** Same as the labels branch — FastAPI/SQLAlchemy/Alembic/pytest (real Postgres), React/TS/vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-labels-sites-and-convert-design.md`

## Global Constraints

- All suites FOREGROUND, one continuous run, `timeout: 600000` ms; never background a suite. API: `cd api && .venv/bin/pytest` (960 tests at branch HEAD `2a7ef76`). Portal: `cd portal && npm test` (739) + `npm run build`.
- `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty; never commit it.
- One migration: `0043_label_template_sites.py` (`revision="0043"`, `down_revision="0042"`), hand-written, clean downgrade.
- API errors `{"detail": {"code": ...}}` via the route file's `_err`. In-models `extra="forbid"`. Mutations audit in the caller's transaction; updates skip audit/version-bump when nothing changed.
- Empty site assignment = GLOBAL (usable everywhere). Update semantics: `site_ids` absent → untouched; a list → full replacement; `[]` → clear to global. Unknown site id → 422 `unknown_site`.
- Convert is one-way, `POST /labels/templates/{id}/convert-to-code`, gate `labels:change`, 409 `not_a_design_template` on code-kind rows, audit action `convert_to_code`.
- Existing tests must stay green; `LabelTemplateOut.site_ids` is ALWAYS present (`[]` for global) so portal types stay non-optional.

---

### Task 1: Migration 0043, model, `site_ids` on template CRUD + filter

**Files:**
- Create: `api/migrations/versions/0043_label_template_sites.py`
- Modify: `api/src/serversherpa/db/models.py` (append `LabelTemplateSite`, add relationship to `LabelTemplate`)
- Modify: `api/src/serversherpa/api/schemas.py` (site_ids on the three template schemas)
- Modify: `api/src/serversherpa/api/routes/labels.py` (create/update/list/get/filter)
- Modify: `api/tests/conftest.py` (TRUNCATE list gains `label_template_sites`)
- Test: `api/tests/test_labels_template_sites_api.py`

**Interfaces:**
- Consumes: existing labels routes/models (branch HEAD), `Site` model (`sites.id` UUID).
- Produces: table `label_template_sites(template_id, site_id)`; ORM `LabelTemplateSite`; `LabelTemplate.site_links: list[LabelTemplateSite]` (cascade delete-orphan); `LabelTemplateOut.site_ids: list[uuid.UUID]` always set; `LabelTemplateCreateIn.site_ids: list[uuid.UUID] | None = None` and same on `LabelTemplateUpdateIn`; `GET /labels/templates?site_id=<uuid>` → assigned + global; route helper `_site_ids_map(db) -> dict[uuid.UUID, list[uuid.UUID]]`.

- [ ] **Step 1: Write the failing tests `api/tests/test_labels_template_sites_api.py`**

```python
"""Site scoping: assignment CRUD, replace semantics, filter incl. globals."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import Site

from tests.test_status_values_write import _make

DESIGN = {"size": {"w": 4, "h": 2}, "elements": []}


def _body(name, **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl",
            "kind": "design", "design": DESIGN}
    base.update(over)
    return base


async def _two_sites(db):
    a, b = Site(name="Site A"), Site(name="Site B")
    db.add(a)
    db.add(b)
    await db.commit()
    return str(a.id), str(b.id)


async def _admin(db, client):
    return await _make(db, client, "admin", "adm@test.example.com")


async def test_create_with_sites_and_get(client, db, seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("scoped", site_ids=[sa, sb]))
    assert resp.status_code == 201, resp.text
    assert sorted(resp.json()["site_ids"]) == sorted([sa, sb])
    got = (await client.get(f"/labels/templates/{resp.json()['id']}",
                            headers=hdrs)).json()
    assert sorted(got["site_ids"]) == sorted([sa, sb])


async def test_create_default_is_global(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("global"))
    assert resp.status_code == 201
    assert resp.json()["site_ids"] == []


async def test_unknown_site_422(client, db, seeded_user):
    hdrs = await _admin(db, client)
    ghost = str(uuid.uuid4())
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("bad", site_ids=[ghost]))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_site"
    assert resp.json()["detail"]["site_id"] == ghost


async def test_patch_replace_clear_and_absent(client, db, seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_body("t", site_ids=[sa]))).json()["id"]
    # replace: version bumps (2)
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": [sb]})
    assert resp.json()["site_ids"] == [sb]
    assert resp.json()["version"] == 2
    # absent: untouched, no bump
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "x"})
    assert resp.json()["site_ids"] == [sb]
    assert resp.json()["version"] == 3  # description changed
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "x"})
    assert resp.json()["version"] == 3  # true no-op
    # same list: no bump
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": [sb]})
    assert resp.json()["version"] == 3
    # clear to global: bumps
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": []})
    assert resp.json()["site_ids"] == [] and resp.json()["version"] == 4


async def test_site_filter_returns_assigned_plus_globals(client, db,
                                                         seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("a-only", site_ids=[sa]))
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("b-only", site_ids=[sb]))
    await client.post("/labels/templates", headers=hdrs, json=_body("global"))
    rows = (await client.get(f"/labels/templates?site_id={sa}",
                             headers=hdrs)).json()
    assert sorted(r["name"] for r in rows) == ["a-only", "global"]
    # composes with existing filters
    rows = (await client.get(
        f"/labels/templates?site_id={sa}&label_type=container",
        headers=hdrs)).json()
    assert rows == []


async def test_listing_carries_site_ids(client, db, seeded_user):
    sa, _sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("t1", site_ids=[sa]))
    rows = (await client.get("/labels/templates", headers=hdrs)).json()
    assert rows[0]["site_ids"] == [sa]
```

- [ ] **Step 2: Run → FAIL**

Run: `cd api && .venv/bin/pytest tests/test_labels_template_sites_api.py -v` (foreground, timeout 600000)
Expected: FAIL — schema rejects `site_ids` (`extra="forbid"`), alembic head still 0042 is fine (conftest upgrades; the new table doesn't exist until Step 3's migration lands — expect table-missing errors until then).

- [ ] **Step 3: Migration `api/migrations/versions/0043_label_template_sites.py`**

```python
"""label_template_sites — site scoping for label templates.

Empty assignment set = GLOBAL (usable everywhere); rows narrow a template
to specific sites. Deliberate replacement for V2's CSV `sites` column:
real FKs both ways, CASCADE so deleting a site or template cleans up its
assignments (a template losing its last site becomes global).

Revision ID: 0043
Revises: 0042
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0043"
down_revision: str | None = "0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "label_template_sites",
        sa.Column("template_id", UUID(as_uuid=True),
                  sa.ForeignKey("label_templates.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id", ondelete="CASCADE"),
                  primary_key=True),
    )
    op.create_index("label_template_sites_site_idx", "label_template_sites",
                    ["site_id"])


def downgrade() -> None:
    op.drop_table("label_template_sites")
```

- [ ] **Step 4: Model additions in `api/src/serversherpa/db/models.py`**

Append after `LabelTemplate` (and add to `LabelTemplate` the relationship line):

```python
class LabelTemplateSite(Base):
    """One row per template-site assignment; no rows = global template."""
    __tablename__ = "label_template_sites"

    template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("label_templates.id", ondelete="CASCADE"),
        primary_key=True)
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True)
```

Inside `class LabelTemplate` add (mirroring `StatusRule.conditions`' style):

```python
    site_links: Mapped[list["LabelTemplateSite"]] = relationship(
        cascade="all, delete-orphan")
```

- [ ] **Step 5: Schemas in `api/src/serversherpa/api/schemas.py`**

`LabelTemplateOut` gains (placed after `is_active`, styled like `usage_count`'s comment):

```python
    # assignment set; [] = global. Populated by the route, not from_attributes.
    site_ids: list[uuid.UUID] = Field(default_factory=list)
```

`LabelTemplateCreateIn` and `LabelTemplateUpdateIn` each gain:

```python
    site_ids: list[uuid.UUID] | None = None
```

- [ ] **Step 6: Route changes in `api/src/serversherpa/api/routes/labels.py`**

Add imports: `LabelTemplateSite`, `Site` to the models import; helpers + wiring:

```python
async def _check_site_ids(db: DbSession, site_ids: list[uuid.UUID]) -> None:
    for sid in site_ids:
        if await db.get(Site, sid) is None:
            raise _err(422, "unknown_site", site_id=str(sid))


async def _site_ids_map(db: DbSession) -> dict[uuid.UUID, list[uuid.UUID]]:
    rows = (await db.execute(select(
        LabelTemplateSite.template_id, LabelTemplateSite.site_id))).all()
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for tid, sid in rows:
        out.setdefault(tid, []).append(sid)
    return out
```

`list_templates`: add `site_id: uuid.UUID | None = None` query param; when set, filter to assigned-or-global:

```python
    if site_id is not None:
        assigned = select(LabelTemplateSite.template_id).where(
            LabelTemplateSite.site_id == site_id)
        has_any = select(LabelTemplateSite.template_id)
        q = q.where(LabelTemplate.id.in_(assigned)
                    | LabelTemplate.id.not_in(has_any))
```

and populate `site_ids` on the way out (convert the handler to build `LabelTemplateOut` items):

```python
    rows = (await db.execute(q)).scalars().all()
    site_map = await _site_ids_map(db)
    out = []
    for r in rows:
        item = LabelTemplateOut.model_validate(r)
        item.site_ids = site_map.get(r.id, [])
        out.append(item)
    return out
```

`get_template`: after the 404 check, `item = LabelTemplateOut.model_validate(row); item.site_ids = [l.site_id for l in row.site_links]; return item` — load `site_links` eagerly with `selectinload`:

```python
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
```

(`from sqlalchemy.orm import selectinload` joins the imports.)

`create_template`: pop `site_ids` out of `values` before `LabelTemplate(**values)`:

```python
    site_ids = values.pop("site_ids", None) or []
    await _check_site_ids(db, site_ids)
    ...
    db.add(row)
    await db.flush()
    for sid in site_ids:
        db.add(LabelTemplateSite(template_id=row.id, site_id=sid))
```

Include the assignment in the create audit snapshot: after the loop, extend the existing `changes` dict:

```python
    changes = diff({}, snapshot(row, TEMPLATE_FIELDS))
    if site_ids:
        changes["site_ids"] = {"from": [], "to": sorted(str(s) for s in site_ids)}
    audit(db, ..., changes=changes)
```

and return via `LabelTemplateOut.model_validate(row)` + `item.site_ids = site_ids`.

`update_template`: pop `site_ids` from `data` before the field loop; treat it as its own change source:

```python
    new_site_ids = data.pop("site_ids", None)
    ...
    changes = diff(before, snapshot(row, TEMPLATE_FIELDS))
    if new_site_ids is not None:
        await _check_site_ids(db, new_site_ids)
        current = sorted(str(l.site_id) for l in row.site_links)
        incoming = sorted(str(s) for s in new_site_ids)
        if current != incoming:
            changes["site_ids"] = {"from": current, "to": incoming}
            row.site_links = [LabelTemplateSite(template_id=row.id,
                                                site_id=sid)
                              for sid in new_site_ids]
    if changes:
        row.version += 1
        ...
```

Load the row with `selectinload(LabelTemplate.site_links)` (same query shape as `get_template`) so `row.site_links` is available, and return `site_ids` on the response the same way. `deactivate_template` needs no site logic.

- [ ] **Step 7: conftest**

Add `label_template_sites` to the TRUNCATE list (before `label_templates` or anywhere — TRUNCATE ... CASCADE handles order; match the list's style). No reseed (no seeded rows).

- [ ] **Step 8: Run focused → PASS, FULL API suite foreground → green (existing template tests must still pass — `site_ids: []` in responses is additive)**

- [ ] **Step 9: Commit**

```bash
git add -A api && git commit -m "feat(api): label template site scoping — join table, site_ids, site filter"
```

---

### Task 2: Convert-to-code endpoint

**Files:**
- Modify: `api/src/serversherpa/api/routes/labels.py`
- Test: `api/tests/test_labels_convert_api.py`

**Interfaces:**
- Consumes: Task 1 state; existing compiler dispatch (`parse_design`, `compile_zpl`, `compile_escp`, `compile_ptouch`) and vocab meta lookups already imported in the route file.
- Produces: `POST /labels/templates/{id}/convert-to-code` (gate `labels:change`) → `LabelTemplateOut` with `kind="code"`, `code=<placeholders-mode compile>`, `design=None`, version+1; 404 `unknown_template`; 409 `not_a_design_template`; audit `convert_to_code`.

- [ ] **Step 1: Write failing tests `api/tests/test_labels_convert_api.py`**

```python
"""Convert-to-code: one-way design->code flip using the stored design."""

from tests.test_status_values_write import _make

DESIGN = {"size": {"w": 4, "h": 2}, "elements": [
    {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
     "rotation": 0, "content": "SN: {serial_number}", "fontSizePt": 12,
     "bold": False, "align": "left"}]}


async def _admin(db, client):
    return await _make(db, client, "admin", "adm@test.example.com")


async def _make_template(client, hdrs, **over):
    body = {"name": "conv", "label_type": "top", "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl", "kind": "design",
            "design": DESIGN}
    body.update(over)
    resp = await client.post("/labels/templates", headers=hdrs, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_convert_matches_compile_output(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs)
    expected = (await client.post("/labels/templates/compile", headers=hdrs,
                                  json={"kind": "design", "design": DESIGN,
                                        "size_key": "4x2", "dpi_key": "203",
                                        "language_key": "zpl",
                                        "mode": "placeholders"})).json()["code"]
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "code" and body["design"] is None
    assert body["code"] == expected
    assert "{serial_number}" in body["code"]  # tokens intact
    assert body["version"] == t["version"] + 1


async def test_convert_persists(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="conv2")
    await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                      headers=hdrs)
    got = (await client.get(f"/labels/templates/{t['id']}",
                            headers=hdrs)).json()
    assert got["kind"] == "code" and got["design"] is None
    assert got["code"].startswith("^XA")


async def test_convert_code_template_409(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="raw", kind="code",
                             design=None, code="^XA^XZ")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_a_design_template"


async def test_convert_brother_language(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="br", language_key="escp")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["code"].startswith("\x1b@")


async def test_convert_unknown_404_and_staff_403(client, db, seeded_user):
    hdrs = await _admin(db, client)
    import uuid as _uuid
    resp = await client.post(
        f"/labels/templates/{_uuid.uuid4()}/convert-to-code", headers=hdrs)
    assert resp.status_code == 404
    from tests.test_sites_api import login
    staff = await login(client)
    t = await _make_template(client, hdrs, name="gate")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=staff)
    assert resp.status_code == 403
```

- [ ] **Step 2: Run → FAIL (404s on the new route)**

- [ ] **Step 3: Implement in `routes/labels.py`**

The compile logic already exists in `compile_template` — extract the shared core so both callers use one implementation (DRY):

```python
async def _compile_design(db: DbSession, design_json: dict, size_key: str,
                          dpi_key: str, language_key: str,
                          subs: dict[str, str] | None) -> str:
    """Shared by the compile endpoint and convert-to-code: vocab lookups,
    size override, parse, language dispatch."""
    size = await db.get(LabelVocab, ("size", size_key))
    dpi = await db.get(LabelVocab, ("dpi", dpi_key))
    lang = await db.get(LabelVocab, ("language", language_key))
    if size is None or dpi is None or lang is None:
        raise _err(404, "unknown_vocab")
    try:
        design = parse_design({
            **design_json,
            "size": {"w": size.meta["width_in"], "h": size.meta["height_in"]},
        })
    except DesignError as e:
        raise _err(422, "bad_design", problems=e.problems) from e
    if lang.key == "zpl":
        return compile_zpl(design, dpi.meta["dots"], subs)
    if lang.key == "escp":
        return compile_escp(design, subs)
    if lang.key == "ptouch":
        return compile_ptouch(design, subs)
    raise _err(422, "unsupported_language", key=lang.key)
```

Refactor `compile_template`'s design branch to call `_compile_design(db, body.design, body.size_key, body.dpi_key, body.language_key, subs)` (its code branch and sample-subs fetch stay as they are). Then:

```python
@router.post("/templates/{template_id}/convert-to-code",
             response_model=LabelTemplateOut)
async def convert_template_to_code(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
) -> LabelTemplateOut:
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
    if row is None:
        raise _err(404, "unknown_template")
    if row.kind != "design":
        raise _err(409, "not_a_design_template")
    code = await _compile_design(db, row.design, row.size_key, row.dpi_key,
                                 row.language_key, None)
    row.kind = "code"
    row.code = code
    row.design = None
    row.version += 1
    row.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="convert_to_code",
          changes={"kind": {"from": "design", "to": "code"}})
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = [l.site_id for l in row.site_links]
    return item
```

- [ ] **Step 4: Run focused → PASS, FULL API suite foreground → green (compile endpoint tests must still pass after the refactor)**

- [ ] **Step 5: Commit**

```bash
git add -A api && git commit -m "feat(api): convert-to-code endpoint for design templates"
```

---

### Task 3: Portal client + Templates list Sites column/facet

**Files:**
- Modify: `portal/src/lib/api.ts` (site_ids on LabelTemplate + create/update bodies pass through; add `convertLabelTemplate`)
- Modify: `portal/src/lib/labels.ts` (site name helpers)
- Modify: `portal/src/pages/LabelTemplates.tsx` (Sites column, facet, export)
- Test: `portal/src/lib/labels.test.ts` (extend), `portal/src/pages/LabelTemplates.test.tsx` (extend)

**Interfaces:**
- Consumes: `listSites(): Promise<SiteItem[]>` (api.ts:829, `SiteItem` has `id: string; name: string`), Task 1-2 endpoints.
- Produces: `LabelTemplate.site_ids: string[]` on the interface; `convertLabelTemplate(id: string): Promise<LabelTemplate>` (POST `/labels/templates/${id}/convert-to-code`, house fetcher pattern); from `lib/labels.ts`: `siteNames(siteIds: string[], sites: Pick<SiteItem, 'id' | 'name'>[]): string[]` (unknown ids render as the raw id) and `sitesCellText(siteIds, sites): string` ("All sites" for empty; "Name" for one; "Name +N" for more).

- [ ] **Step 1: Extend `portal/src/lib/labels.test.ts` (failing)**

```ts
import { siteNames, sitesCellText } from './labels';

const SITES = [{ id: 's1', name: 'NAP7' }, { id: 's2', name: 'NAP11' }];

it('siteNames maps ids and keeps unknown ids raw', () => {
  expect(siteNames(['s2', 'ghost'], SITES)).toEqual(['NAP11', 'ghost']);
});

it('sitesCellText renders global, single, and overflow states', () => {
  expect(sitesCellText([], SITES)).toBe('All sites');
  expect(sitesCellText(['s1'], SITES)).toBe('NAP7');
  expect(sitesCellText(['s1', 's2'], SITES)).toBe('NAP7 +1');
});
```

(Merge the import into the file's existing import from `./labels`.)

- [ ] **Step 2: Run → FAIL** (`npx vitest run src/lib/labels.test.ts`)

- [ ] **Step 3: Implement**

`api.ts`: add `site_ids: string[];` to `interface LabelTemplate` (after `is_active`); create/update fetchers take `Record<string, unknown>` bodies already — no signature change. Add:

```ts
export async function convertLabelTemplate(id: string): Promise<LabelTemplate> {
  const resp = await apiFetch(`/labels/templates/${id}/convert-to-code`, {
    method: 'POST',
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

`lib/labels.ts`:

```ts
export function siteNames(
  siteIds: string[], sites: { id: string; name: string }[],
): string[] {
  return siteIds.map((id) => sites.find((s) => s.id === id)?.name ?? id);
}

export function sitesCellText(
  siteIds: string[], sites: { id: string; name: string }[],
): string {
  if (siteIds.length === 0) return 'All sites';
  const names = siteNames(siteIds, sites);
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
```

- [ ] **Step 4: Extend `LabelTemplates.test.tsx` (failing first): mock `listSites` (add to the hoisted api mock) resolving `[{ id: 's1', name: 'NAP7' }, { id: 's2', name: 'NAP11' }]`; give mock row t1 `site_ids: ['s1', 's2']` and t2 `site_ids: []`; assert:**

```ts
it('Sites column shows names with overflow and All sites for globals', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  expect(screen.queryByText('NAP7 +1')).not.toBeNull();
  expect(screen.queryByText('All sites')).not.toBeNull();
});
```

(Existing mock rows in that file gain `site_ids` so TS stays happy.)

- [ ] **Step 5: Implement the page changes in `LabelTemplates.tsx`**

- Load sites alongside the existing fetches: `const [sites, setSites] = useState<SiteItem[]>([]);` and `Promise.all` gains `listSites()` (failure of the sites fetch must NOT block the list — wrap it: `listSites().catch(() => [])`).
- `COLUMNS` gains `{ key: 'sites', label: 'Sites', width: '1.1fr', default: true },` after `is_active`. NOTE the known persisted-column-prefs gotcha (usePersistentListState hides new default columns for users with saved prefs) — accept it, as previous pages did.
- Cell: `sitesCellText(t.site_ids, sites)` — render in a muted span (`className="cell-sub"`) when global, plain text otherwise.
- Facet group `sites`: options = `[{ value: '', label: 'All sites (global)' }, ...sites-used-in-rows]` where the values facet uses site ids present in loaded rows; `passesFacets` value fn returns `t.site_ids.length ? t.site_ids : ['']`.
- CSV export column: `['Sites', (t) => siteNames(t.site_ids, sites).join('; ')]`.
- Search haystack: append `siteNames(t.site_ids, sites).join(' ').toLowerCase()` to the haystack builder so site names are findable.

- [ ] **Step 6: Run focused (both test files) → PASS, FULL portal suite + `npm run build` → green**

- [ ] **Step 7: Commit**

```bash
git add -A portal && git commit -m "feat(portal): Sites column, facet, and export on the templates list"
```

---

### Task 4: Editor site selector

**Files:**
- Modify: `portal/src/pages/LabelTemplateEditor.tsx`
- Modify: `portal/src/styles/labels.css` (selector row spacing only if needed)
- Test: `portal/src/pages/LabelTemplateEditor.test.tsx` (extend)

**Interfaces:**
- Consumes: `TagInput` default export from `portal/src/components/TagInput.tsx` — options mode: `<TagInput value={string[]} onChange={(tags) => ...} options={{ value, label }[]} placeholder disabled />`; a value with no matching option renders by raw key and stays removable (covers deleted sites). `listSites`, Task 3's `site_ids` field.
- Produces: editor save body includes `site_ids` (always, both kinds, create and update); the control labeled "Sites" with an "All sites" hint when empty.

- [ ] **Step 1: Extend `LabelTemplateEditor.test.tsx` (failing): add `listSites` to the api mock (`[{ id: 's1', name: 'NAP7' }, { id: 's2', name: 'NAP11' }]` — `as never` widening if `SiteItem` has more required fields; check the real type and fill minimally); update `getLabelTemplate` mock to include `site_ids: ['s1']`; add:**

```ts
it('edit loads site chips and save sends site_ids', async () => {
  api.getLabelTemplate.mockResolvedValue({
    id: 't1', name: 'Front tag', description: '', label_type: 'front',
    size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'code',
    design: null, code: '^XA^XZ', version: 2, is_active: true,
    site_ids: ['s1'], created_at: '', updated_at: '' });
  api.updateLabelTemplate.mockResolvedValue({ id: 't1' });
  renderAt('/labels/templates/t1/edit');
  await waitFor(() => expect(screen.queryByText('NAP7')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledWith(
    't1', expect.objectContaining({ site_ids: ['s1'] })));
});

it('new template defaults to no sites (global)', async () => {
  api.createLabelTemplate.mockResolvedValue({ id: 't-new', kind: 'code' });
  renderAt('/labels/templates/new?kind=code');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  await userEvent.type(screen.getByLabelText('Name'), 'g');
  await userEvent.type(screen.getByLabelText('Template code'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
  expect(api.createLabelTemplate.mock.calls[0][0].site_ids).toEqual([]);
});
```

Existing tests keep passing (they use `objectContaining` / specific field asserts).

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement in `LabelTemplateEditor.tsx`**

- State: `const [siteIds, setSiteIds] = useState<string[]>([]);` and `const [sites, setSites] = useState<SiteItem[]>([]);` — mount `Promise.all` gains `listSites().catch(() => [])`; edit-load sets `setSiteIds(t.site_ids)`.
- Save body gains `site_ids: siteIds` (both kinds; the update path that strips `kind` keeps `site_ids`).
- UI: a second top-bar row (or the existing flex-wrap row) with:

```tsx
<div className="label-editor-sites">
  <span className="eyebrow-sm">Sites</span>
  <TagInput value={siteIds} onChange={setSiteIds}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            placeholder={siteIds.length ? 'Add a site…' : 'All sites — add to narrow'} />
</div>
```

with `.label-editor-sites { display: flex; align-items: center; gap: 10px; margin: -6px 0 12px; }` and a min-width on the TagInput wrapper (`flex: 1; max-width: 520px;`) in `labels.css`.

- [ ] **Step 4: Run focused → PASS, FULL portal suite + build → green**

- [ ] **Step 5: Commit**

```bash
git add -A portal && git commit -m "feat(portal): site selector on the label template editor"
```

---

### Task 5: Convert-to-code UI (editor button + row action)

**Files:**
- Modify: `portal/src/pages/LabelTemplateEditor.tsx`
- Modify: `portal/src/pages/LabelTemplates.tsx`
- Test: `portal/src/pages/LabelTemplateEditor.test.tsx`, `portal/src/pages/LabelTemplates.test.tsx` (extend)

**Interfaces:**
- Consumes: `convertLabelTemplate(id)` (Task 3), editor `kind`/`setKind`/`setCodeText` state (Task 15 of the original plan).
- Produces: editor top-bar button "Edit as raw ZPL" (label "Edit as raw code" when `meta.language_key !== 'zpl'`) on saved design-kind templates only (`!isCreate && kind === 'design'`), gated `can('labels','change')`; row-menu action on design rows.

- [ ] **Step 1: Extend tests (failing)**

`LabelTemplateEditor.test.tsx`:

```ts
it('converts a design template to raw code after confirm', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getLabelTemplate.mockResolvedValue({
    id: 't9', name: 'Builder', description: '', label_type: 'top',
    size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'design',
    design: { size: { w: 4, h: 2 }, elements: [] }, code: null, version: 1,
    is_active: true, site_ids: [], created_at: '', updated_at: '' });
  api.convertLabelTemplate.mockResolvedValue({
    id: 't9', kind: 'code', code: '^XA^CONVERTED^XZ', design: null,
    name: 'Builder', description: '', label_type: 'top', size_key: '4x2',
    dpi_key: '203', language_key: 'zpl', version: 2, is_active: true,
    site_ids: [], created_at: '', updated_at: '' });
  renderAt('/labels/templates/t9/edit');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Edit as raw ZPL' })).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Edit as raw ZPL' }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(api.convertLabelTemplate).toHaveBeenCalledWith('t9'));
  const ta = await screen.findByLabelText('Template code') as HTMLTextAreaElement;
  expect(ta.value).toBe('^XA^CONVERTED^XZ');
});

it('no convert button on new or code-kind templates', async () => {
  renderAt('/labels/templates/new?kind=design');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  expect(screen.queryByRole('button', { name: /Edit as raw/ })).toBeNull();
});
```

(Add `convertLabelTemplate: vi.fn()` to the hoisted api mock.)

`LabelTemplates.test.tsx`:

```ts
it('row menu offers Edit as raw ZPL on design rows only', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  const designRow = screen.getByText('Front tag').closest('.dir-row')!;
  await userEvent.click(within(designRow as HTMLElement)
    .getByRole('button', { name: /Actions/ }));
  expect(screen.queryByText('Edit as raw ZPL')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  const codeRow = screen.getByText('Crate tag').closest('.dir-row')!;
  await userEvent.click(within(codeRow as HTMLElement)
    .getByRole('button', { name: /Actions/ }));
  expect(screen.queryByText(/Edit as raw/)).toBeNull();
});
```

(Adjust the second row's name to whatever the existing code-kind mock row is called — the file already has one; reuse its name.)

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

Editor (`LabelTemplateEditor.tsx`):

```tsx
const convertToCode = async () => {
  if (!id) return;
  if (!window.confirm(
    'One-way: the draggable elements are discarded and this becomes a '
    + 'raw-code template. Unsaved canvas edits are not included. Continue?')) return;
  try {
    const t = await convertLabelTemplate(id);
    setKind('code');
    setCodeText(t.code ?? '');
    setError('');
  } catch {
    setError('Convert failed.');
  }
};
```

Button in the top bar, next to Save:

```tsx
{!isCreate && kind === 'design' && can('labels', 'change') && (
  <button className="mini-btn" type="button" onClick={() => void convertToCode()}>
    {meta.language_key === 'zpl' ? 'Edit as raw ZPL' : 'Edit as raw code'}
  </button>
)}
```

List (`LabelTemplates.tsx`) row actions — insert between Edit and Deactivate, pre-gated:

```tsx
...(canChange && t.kind === 'design' ? [{
  key: 'convert', label: 'Edit as raw ZPL',
  onSelect: () => {
    if (!window.confirm('One-way: the draggable elements are discarded and '
      + 'this becomes a raw-code template. Continue?')) return;
    void convertLabelTemplate(t.id)
      .then(() => navigate(`/labels/templates/${t.id}/edit`))
      .catch(() => setError('Convert failed.'));
  },
}] : []),
```

(Reuse the page's existing error display state; check its actual setter name.)

- [ ] **Step 4: Run focused (both files) → PASS, FULL portal suite + build → green**

- [ ] **Step 5: Commit**

```bash
git add -A portal && git commit -m "feat(portal): edit-as-raw-ZPL convert action in editor and list"
```

---

### Task 6: Final verification

**Files:** none expected (fixes only if found).

- [ ] **Step 1:** FULL API suite foreground → green; FULL portal suite + `npm run build` → green. `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty.
- [ ] **Step 2:** `cd api && .venv/bin/alembic upgrade head` (dev DB 0042 → 0043).
- [ ] **Step 3:** Live walkthrough (Browser pane, claude-dev login, known login/scroll quirks): (a) Templates list shows the Sites column ("All sites" on both existing templates); (b) open "Top asset tag", add two sites via the chips combo, Save → list shows "Name +1", version bumped; remove one, Save, re-open — chip state round-trips; (c) filter check: `GET /labels/templates?site_id=<one of them>` via the page facet or curl returns the scoped template + globals; (d) convert flow: duplicate-check — click "Edit as raw ZPL" on a design template (use a THROWAWAY: create "convert-me" in the builder with one text element first), confirm, verify the textarea appears with generated ZPL and the list shows kind "Raw code"; (e) screenshot proof of the Sites chips + converted template.
- [ ] **Step 4:** Confirm `git log --oneline` shows every task commit; leave branch unmerged.

## Out of scope (per spec)

Per-site resolution at generation time; code→design conversion; site-scoping vocab/placeholders.
