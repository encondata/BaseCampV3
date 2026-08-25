# Partner Type Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the hardcoded partner-type `Literal` (staffing/logistics/subcontractor/consultant/other) with an admin-editable `partner_type` status_values vocabulary, seeded with those five plus `tech` and `cable`, and align storage with the `initiatives.shipping_types` pattern (text[]).

**Architecture:** Migration converts `partners.partner_types` JSONB→`text[] NOT NULL DEFAULT '{}'` and seeds the vocabulary; the API validates against `status_values` (the initiatives `shipping_types` idiom) instead of a pydantic Literal; the portal reads the vocabulary from `/status-values?record_type=partner_type` instead of the hardcoded `TYPE_LABEL` map. The initiative partner pickers need no change — their keyword match hits the new `tech`/`cable` keys exactly.

**Tech Stack:** Existing — Alembic, SQLAlchemy async, pydantic, React/Vite.

## Global Constraints

- API checks: `cd api && .venv/bin/pytest`. Portal checks: `cd portal && npx tsc --noEmit && npx vitest run`.
- Errors are `{"code": ...}` machine codes; unknown vocab key → 422 `unknown_partner_type` (mirror the initiatives router's `unknown_shipping_type` handling, values listed in `extra`).
- House palette only: `#178a4c`, `#0f7c86`, `#51606f`, `#c03540`, `#a36207`, `#1668a7`, `#6d4fc4`.
- conftest must restore the new vocabulary seeds between tests, matching the migration exactly.
- Working tree hygiene: other sessions have uncommitted changes in `api/src/serversherpa/api/routes/initiatives.py` and `api/tests/test_initiative_*.py` — do NOT touch, stage, or commit those files.

---

### Task 1: Vocabulary migration + API validation

**Files:**
- Create: `api/migrations/versions/0017_partner_type_vocab.py` (next free number — check `ls api/migrations/versions/` first)
- Modify: `api/src/serversherpa/db/models.py` (Partner.partner_types JSONB → ARRAY(Text))
- Modify: `api/src/serversherpa/status/registry.py` (add entry)
- Modify: `api/src/serversherpa/api/schemas.py` (drop the PartnerType Literal — find it with grep; partner_types becomes `list[str]`)
- Modify: `api/src/serversherpa/api/routes/stakeholders.py` (validate against the vocabulary on create/update where partner_types is accepted)
- Modify: `api/tests/conftest.py` (seed-restore block)
- Test: extend the existing stakeholders test file (find it: `grep -rl partner_types api/tests/`)

**Requirements (prose spec — read the existing code and follow its idioms):**

1. Migration `0017_partner_type_vocab`, revises 0016:
   - Seed `status_values` record_type `partner_type`:
     `('partner_type','staffing','Staffing','Contract labour.','#1668a7',1)`,
     `('partner_type','logistics','Logistics','Transport & freight.','#a36207',2)`,
     `('partner_type','tech','Tech','Hands-on technical services.','#178a4c',3)`,
     `('partner_type','cable','Cable','Structured cabling.','#0f7c86',4)`,
     `('partner_type','subcontractor','Subcontractor','General subcontracting.','#6d4fc4',5)`,
     `('partner_type','consultant','Consultant','Advisory services.','#51606f',6)`,
     `('partner_type','other','Other','Anything else.','#c03540',7)`
   - Convert the column: `ALTER TABLE partners ALTER COLUMN partner_types TYPE text[] USING (ARRAY(SELECT jsonb_array_elements_text(partner_types)))`, then set `NOT NULL DEFAULT '{}'::text[]` (drop the old jsonb server default first). Existing keys already match the seeds — no value rewrite.
   - `downgrade()` reverses: column back to JSONB (`to_jsonb(partner_types)` USING clause, `'[]'::jsonb` default) and deletes the `partner_type` seeds.
2. Model: `partner_types: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'::text[]"))` — mirror the `Initiative.shipping_types` style (comment that the API validates values).
3. Registry: `StatusRecordType("partner_type", "Partner type", table="partners", column="partner_types", resource="partners", array=True)` — the array usage-count branch already exists and uses `unnest`, which works on `text[]` (this is WHY the column converts from JSONB).
4. Schemas: remove the `Literal` union for partner types; the field becomes `list[str]` (keep optionality exactly as it is today). Grep for the Literal's name to find every use.
5. Router validation: wherever create/update accepts `partner_types`, validate each key against `status_values` record_type `partner_type` → 422 `{"code": "unknown_partner_type", "values": [...]}`. Mirror `_check_refs`'s shipping_types block in `api/src/serversherpa/api/routes/initiatives.py`.
6. conftest: add a `partner_type` seed-restore block (delete record_type + re-INSERT the canonical seven, exactly matching the migration).
7. Tests (TDD — failing first): create partner with `["tech"]` succeeds (round-trips in the list payload); `["hovercraft"]` → 422 `unknown_partner_type`; existing five keys still accepted; `GET /status-values?record_type=partner_type` returns 7 rows with correct usage counts after creating a tagged partner (needs an actor whose roles can read it — follow the shipping_type usage test in `api/tests/test_initiatives_api.py`).
8. Run the full API suite before committing (`.venv/bin/pytest`); commit ONLY the files this task owns:
   `git add api/migrations/versions/0017_partner_type_vocab.py api/src/serversherpa/db/models.py api/src/serversherpa/status/registry.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/stakeholders.py api/tests/conftest.py <the stakeholders test file>`
   Commit message: `feat(api): partner types become an admin-editable status_values vocabulary`

### Task 2: Portal reads the vocabulary

**Files:**
- Modify: `portal/src/lib/api.ts` (add `listPartnerTypes()` → `/status-values?record_type=partner_type`, next to the other status-values helpers)
- Modify: `portal/src/lib/orgs.ts` (TYPE_LABEL becomes a fallback; cell/filter text resolves labels from a vocab map passed in — keep functions pure, follow how the file already parameterizes)
- Modify: the Partners page / `OrgDirectory` component (find via `grep -rl OrgDirectory portal/src`): fetch the vocabulary, use it for the type multi-select options and the type chips (chip colors from the vocab `color`), replacing any hardcoded list
- Test: extend `portal/src/lib/orgs.test.ts` for the label-resolution change

**Requirements:**

1. The partner type editor (TagInput or multi-select — read the current implementation first) offers exactly the vocabulary's active values; free typing of arbitrary types is no longer offered.
2. Type chips render the vocab label and color (`chip custom` + `--chip` pattern) with `#51606f` fallback for unknown keys (a retired key on an existing partner must still render, by key).
3. `TYPE_LABEL` stays only as a last-resort fallback for unknown keys, or is removed if nothing else imports it (grep first).
4. `cd portal && npx tsc --noEmit && npx vitest run` clean before committing; commit only this task's files.
   Commit message: `feat(portal): partner type picker and chips read the partner_type vocabulary`
