# Natural Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every list, column sort and dropdown in the portal and kiosk, and every server-sorted list, orders text naturally: numbers by value, case ignored.

**Architecture:** A Postgres ICU collation `natural` (migration 0082) plus a one-line `natural(column)` helper used by every text `order_by` in the API. In the front ends, one cached `Intl.Collator` comparator (`portal/src/lib/naturalSort.ts`) used by every string sort, enforced by a grep-style guardrail test.

**Tech Stack:** Postgres 16 (ICU), SQLAlchemy async + Alembic, pytest; React/TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-natural-sort-design.md`

## Global Constraints

- Collation (exact): name `natural`, `provider = icu`, `locale = 'en-u-kn-true-ks-level2'`, `deterministic = false`. Migration file `api/migrations/versions/0082_natural_collation.py`, `revision = "0082"`, `down_revision = "0080"` (chain on main: `0073 → 0081 → 0080 → 0082`). Downgrade drops it.
- The collation is used ONLY in `ORDER BY` (SQLAlchemy `order_by`), never in `WHERE`/`LIKE`/`DISTINCT`/`GROUP BY`/joins/indexes.
- Helper (exact): `serversherpa.db.ordering.natural(column)` → `column.collate("natural")`.
- Every `order_by` on a text column in `api/src/serversherpa` uses `natural(...)`; numeric, timestamp, rank, position, sort_order, seq, id and boolean expressions are untouched.
- Portal comparator (exact): `naturalCompare(a, b)` and `sortNatural(items, key)` in `portal/src/lib/naturalSort.ts`; `Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' })` built once (matches `ks-level2`: case-insensitive, accent-sensitive). `compareOrdinal(a, b)` for ISO timestamps and ids. `portal/src/lib/sites.ts` re-exports `naturalCompare` from it.
- Guardrail (exact rules): no `localeCompare(` and no `new Intl.Collator(` outside `portal/src/lib/naturalSort.ts`; no comparator-less `.sort()` or `.toSorted()` (no allowlist — use `compareOrdinal` for ids and timestamps); comment lines skipped. Scans `portal/src` and `kiosk/src`, skipping `*.test.ts`/`*.test.tsx`.
- Expected order (exact, used by tests): `["Rack 10", "Rack 2", "rack 1", "Rack 1a"]` sorts to `["rack 1", "Rack 1a", "Rack 2", "Rack 10"]`.
- American English. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Environment (worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/natural-sort`):** `api/.venv`, `portal/node_modules`, `kiosk/node_modules` are symlinks; `.env` copied. API tests: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_natsort .venv/bin/pytest tests/<file> -q` — FOREGROUND, long timeout, never background, never pip/npm install, never `git stash`. Portal: `cd portal && npx vitest run <paths>`; `npx tsc -b`. Kiosk: `cd kiosk && npx vitest run`; `npx tsc -b`.

---

### Task 1: Collation migration, ordering helper, and every API text ordering

**Files:**
- Create: `api/migrations/versions/0082_natural_collation.py`
- Create: `api/src/serversherpa/db/ordering.py`
- Modify: every file listed by `grep -rn "order_by" api/src/serversherpa` that orders a text column (inventory in Step 3)
- Test: `api/tests/test_natural_ordering.py` (new)

**Interfaces:**
- Produces: `natural(column)` in `serversherpa.db.ordering`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_natural_ordering.py`:

```python
"""Natural ordering: the `natural` ICU collation (migration 0082) and the
list endpoints that order text with it."""

from sqlalchemy import text

from serversherpa.db.models import Container, Initiative, Person, Site

from tests.test_status_values_write import _make

NAMES = ["Rack 10", "Rack 2", "rack 1", "Rack 1a"]
EXPECTED = ["rack 1", "Rack 1a", "Rack 2", "Rack 10"]


async def test_collation_orders_numbers_by_value_and_ignores_case(db):
    rows = await db.execute(text(
        "SELECT x FROM unnest(CAST(:names AS text[])) AS t(x) ORDER BY x COLLATE natural"),
        {"names": NAMES})
    assert [r[0] for r in rows] == EXPECTED


async def test_sites_list_is_naturally_ordered(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin@test.example.com")
    for n in NAMES:
        db.add(Site(name=n, status="active"))
    await db.commit()
    body = (await client.get("/sites", headers=hdrs)).json()
    names = [s["name"] for s in body if s["name"] in NAMES]
    assert names == EXPECTED


async def test_people_lists_order_last_names_naturally(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin2@test.example.com")
    for n in NAMES:
        db.add(Person(first_name="Pat", last_name=n))
    await db.commit()
    body = (await client.get("/workers", headers=hdrs)).json()
    rows = body["items"] if isinstance(body, dict) else body
    lasts = [w["last_name"] for w in rows if w.get("last_name") in NAMES]
    assert lasts == EXPECTED


async def test_containers_list_is_naturally_ordered(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin3@test.example.com")
    init = Initiative(name="Nat move", kind="move")
    db.add(init)
    await db.flush()
    for n in NAMES:
        db.add(Container(name=n, initiative_id=init.id))
    await db.commit()
    body = (await client.get("/containers", headers=hdrs)).json()
    rows = body["items"] if isinstance(body, dict) else body
    names = [c["name"] for c in rows if c["name"] in NAMES]
    assert names == EXPECTED
```

Adjust the fixture fields to the models' required columns (look at how `tests/test_sites_api.py`, `tests/test_workers.py` and `tests/test_containers_api.py` create rows; the `Site`/`Initiative`/`Container` constructors above are illustrative — use the real required fields and the real list-response shapes). Keep `NAMES`/`EXPECTED` exactly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_natsort .venv/bin/pytest tests/test_natural_ordering.py -q`
Expected: FAIL — `collation "natural" for encoding "UTF8" does not exist`, and the list tests return `Rack 1a, Rack 10, Rack 2, rack 1`-style orders.

- [ ] **Step 3: Migration and helper**

Create `api/migrations/versions/0082_natural_collation.py`:

```python
"""The `natural` collation: numbers inside text compare by value and case is
ignored, so lists read "Rack 2, Rack 10" instead of "Rack 10, Rack 2".

ICU, numeric (kn), case-insensitive (ks-level2), non-deterministic — used
ONLY in ORDER BY (see serversherpa.db.ordering.natural). Postgres 16 with
ICU, which the dev and production servers have.

Revision ID: 0082
Revises: 0080
Create Date: 2026-09-28

The unmerged `wiki` (0074–0079) and `spec-lookup` (0080) branches also
start from 0081; whichever merges next re-points its first migration.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0082"
down_revision: str | None = "0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE COLLATION natural (provider = icu, "
        "locale = 'en-u-kn-true-ks-level2', deterministic = false)")


def downgrade() -> None:
    op.execute("DROP COLLATION natural")
```

Create `api/src/serversherpa/db/ordering.py`:

```python
"""Natural ordering for text columns: `order_by(natural(Site.name))` sorts
"Rack 2" before "Rack 10" and ignores case, through the `natural` ICU
collation from migration 0082.

ORDER BY only. The collation is non-deterministic, so it must never be
used in WHERE, LIKE, DISTINCT, GROUP BY, joins or indexes — equality and
search keep the column's own collation.
"""

from sqlalchemy.sql import ColumnElement


def natural(column: ColumnElement) -> ColumnElement:
    return column.collate("natural")
```

- [ ] **Step 4: Switch every text ordering**

Run `grep -rn "order_by" api/src/serversherpa` and, for every ordering of a text column — names, labels, `make`/`model`, `serial_number`, `alias`, `description`, `role`, `resource`/`action`, `email`, `last_name`/`first_name`, `display_name`, code/key strings — wrap the column in `natural(...)` (import `from serversherpa.db.ordering import natural`). Leave numeric, boolean, timestamp, `rank`, `position`, `sort_order`, `seq`, `id`, `priority_wave`, `scheduled_*`, `expires_on`, `day_col` and `func.*` expressions alone. Where an ordering mixes both (`order_by(rank, Person.last_name)`), wrap only the text parts. `.desc()`/`.asc()`/`.nullslast()` on a text column become `natural(col).desc()` etc. Inventory at the time of writing (78 lines across ~30 files): `routes/search.py` (6), `ai/tools.py` (6), `routes/users.py` (5), `routes/stakeholders.py` (5), `assets/bulk_update.py` (4), `routes/warehouse.py` (4), `routes/kiosk.py` (4), `labels/generate/select.py` (3), `routes/notifications.py` (3), `routes/labels.py` (3), `routes/asset_models.py` (3), `routes/access.py` (3), `warehouse/seed.py`, `people/bulk_import.py`, `labels/generate/runner.py`, `routes/trucks.py`, `routes/sites.py`, `routes/initiatives.py`, `routes/devices.py` (2 each), and one each in `trucks/bulk_import.py`, `status_rules/engine.py`, `spec_lookup/service.py`, `sites/bulk_import.py`, `reports/site_move_survey/gather.py`, `reports/move_scan_history/gather.py`, `reports/move_report/gather.py`, `people/team_bulk.py`, `assets/model_index.py`, `routes/workers.py`, `routes/time.py`. Also check `services/*.py` and `routes/assets.py` (its column-sort map for the paginated Assets list) — the grep is the source of truth, not this list.

Do NOT touch orderings that a `DISTINCT ON` or a window function depends on unless the same expression is used consistently (a `DISTINCT ON (x)` must match the leading `ORDER BY x`; if you collate one, collate both, or leave that one alone and note it in the report).

- [ ] **Step 5: Run the tests**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_natsort .venv/bin/pytest tests/test_natural_ordering.py tests/test_sites_api.py tests/test_containers_api.py tests/test_workers.py tests/test_users_api.py tests/test_search_api.py tests/test_asset_models_api.py -q` (use the real file names; `ls api/tests | grep -i "site\|container\|worker\|user\|search\|model"`).
Expected: PASS. Then `cd api && PYTHONPATH=$PWD/src .venv/bin/alembic heads` → `0082 (head)`.

- [ ] **Step 6: Commit**

```bash
git add api/migrations/versions/0082_natural_collation.py api/src/serversherpa/db/ordering.py api/src api/tests/test_natural_ordering.py
git commit -m "feat(api): natural ordering — ICU collation 0082 and natural() on every text order_by

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Portal comparator, every string sort, and the guardrail

**Files:**
- Create: `portal/src/lib/naturalSort.ts`, `portal/src/lib/naturalSort.test.ts`
- Create: `portal/src/styles/naturalSort.test.ts`, `portal/src/styles/naturalSort.allow.json`
- Modify: `portal/src/lib/sites.ts` (re-export; drop its collator)
- Modify: every portal file that orders strings (inventory in Step 4)

**Interfaces:**
- Produces: `naturalCompare(a: string | null | undefined, b: string | null | undefined): number`, `sortNatural<T>(items: readonly T[], key: (t: T) => string | null | undefined): T[]` from `portal/src/lib/naturalSort.ts`. Task 3 (kiosk) imports the same module through `@portal/lib/naturalSort`.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/lib/naturalSort.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { naturalCompare, sortNatural } from './naturalSort';

describe('naturalCompare', () => {
  it('orders numbers by value and ignores case', () => {
    expect(['Rack 10', 'Rack 2', 'rack 1', 'Rack 1a'].sort(naturalCompare))
      .toEqual(['rack 1', 'Rack 1a', 'Rack 2', 'Rack 10']);
  });
  it('treats missing values as empty strings, which sort first', () => {
    expect([...['b', null, 'a', undefined]].sort(naturalCompare)).toEqual([null, undefined, 'a', 'b']);
  });
  it('is stable for case-only differences', () => {
    expect(naturalCompare('Rack 1', 'rack 1')).toBe(0);
  });
});

describe('sortNatural', () => {
  it('returns a sorted copy without mutating the input', () => {
    const items = [{ n: 'Site 10' }, { n: 'site 9' }, { n: 'Site 1' }];
    const out = sortNatural(items, (i) => i.n);
    expect(out.map((i) => i.n)).toEqual(['Site 1', 'site 9', 'Site 10']);
    expect(items.map((i) => i.n)).toEqual(['Site 10', 'site 9', 'Site 1']);
  });
});
```

Create `portal/src/styles/naturalSort.test.ts` (model the file walking and reporting on `portal/src/styles/listTypography.test.ts`):

```ts
/**
 * Guardrail: text ordering goes through lib/naturalSort.ts, so "Rack 10"
 * never lands before "Rack 2" again.
 *  (a) no `localeCompare(` outside portal/src/lib/naturalSort.ts;
 *  (b) no `new Intl.Collator(` outside that file;
 *  (c) no comparator-less `.sort()` unless naturalSort.allow.json lists
 *      that file:line with a reason (numeric arrays, already-ordered input).
 * Scans portal/src and kiosk/src, skipping *.test.ts / *.test.tsx.
 * Violations print a ready-to-paste allowlist entry.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PORTAL_SRC = join(__dirname, '..');
const KIOSK_SRC = join(__dirname, '..', '..', '..', 'kiosk', 'src');
const COMPARATOR = 'lib/naturalSort.ts';

interface Allow { file: string; line: number; reason: string }
const allow: Allow[] = JSON.parse(readFileSync(join(__dirname, 'naturalSort.allow.json'), 'utf8'));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function scan(root: string, prefix: string): string[] {
  const out: string[] = [];
  for (const file of walk(root)) {
    const rel = `${prefix}${relative(root, file)}`;
    if (rel === `portal/src/${COMPARATOR}`) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const line = i + 1;
      if (text.includes('localeCompare(')) out.push(`${rel}:${line}: localeCompare — use naturalCompare from lib/naturalSort`);
      if (text.includes('new Intl.Collator(')) out.push(`${rel}:${line}: Intl.Collator — use naturalCompare from lib/naturalSort`);
      if (/\.sort\(\s*\)/.test(text) && !allow.some((a) => a.file === rel && a.line === line)) {
        out.push(`${rel}:${line}: bare .sort() — pass naturalCompare, or allowlist it:\n` +
          JSON.stringify({ file: rel, line, reason: '' }, null, 2));
      }
    });
  }
  return out;
}

describe('natural sort guardrail', () => {
  it('every text ordering uses lib/naturalSort', () => {
    const violations = [...scan(PORTAL_SRC, 'portal/src/'), ...scan(KIOSK_SRC, 'kiosk/src/')];
    expect(violations, violations.join('\n\n')).toEqual([]);
  });
  it('allowlist entries still point at a bare .sort()', () => {
    for (const a of allow) {
      const root = a.file.startsWith('kiosk/') ? join(KIOSK_SRC, '..', '..') : join(PORTAL_SRC, '..', '..');
      const text = readFileSync(join(root, a.file), 'utf8').split('\n')[a.line - 1] ?? '';
      expect(text, `${a.file}:${a.line} no longer has a bare .sort()`).toMatch(/\.sort\(\s*\)/);
    }
  });
});
```

Create `portal/src/styles/naturalSort.allow.json` as `[]` to start.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/lib/naturalSort.test.ts src/styles/naturalSort.test.ts`
Expected: the unit test FAILS (module missing); the guardrail FAILS listing every `localeCompare`, the collator in `lib/sites.ts`, and each bare `.sort()`.

- [ ] **Step 3: The comparator**

Create `portal/src/lib/naturalSort.ts`:

```ts
/**
 * The one way to order text in the portal and kiosk: numbers inside a
 * string compare by value ("Rack 2" before "Rack 10") and case is ignored.
 * Matches the API's `natural` collation, so a server-sorted list and a
 * client re-sort agree. The guardrail in styles/naturalSort.test.ts keeps
 * every other string sort pointed here.
 */

// one collator — constructing one per comparison is measurably slow
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' });

export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return COLLATOR.compare(a ?? '', b ?? '');
}

/** A sorted copy of `items`, by the text `key` gives for each. */
export function sortNatural<T>(items: readonly T[], key: (item: T) => string | null | undefined): T[] {
  return [...items].sort((x, y) => naturalCompare(key(x), key(y)));
}
```

In `portal/src/lib/sites.ts`: delete its `COLLATOR` constant and `naturalCompare` function, and add `export { naturalCompare } from './naturalSort';` (keep every existing import of `naturalCompare` from `../lib/sites` working; you may also switch those imports to the new module, but the re-export stays).

- [ ] **Step 4: Switch every string sort**

Work through the guardrail's list. For each hit:
- `x.localeCompare(y)` → `naturalCompare(x, y)` (import from `'../lib/naturalSort'` or the right relative path). Chains like `a.sort_order - b.sort_order || a.key.localeCompare(b.key)` keep the numeric part and swap only the string part.
- `localeCompare(…, undefined, { numeric: true })` → `naturalCompare(…)`.
- Bare `.sort()` on an array of strings → `.sort(naturalCompare)`; on numbers → `.sort((a, b) => a - b)`; if the array is already ordered or genuinely doesn't matter, allowlist it with a one-line reason instead.
- List pages whose column comparator does `typeof va === 'string' ? va.localeCompare(vb) : va - vb` (Workers, Users, External, Reports, MoveDashboard, FixedReaders, Routers, KioskDevices, LabelTemplates, Containers, Trucks, Warehouse, TimeManagement, StakeholderDetail, InitiativeDetail, OrgDirectory, Variables, Audit, Notifications, AssetModels, RulesTab, MembersTab, RawSurveyList…) → the string branch uses `naturalCompare`.
- Dropdown/option builders (`.map(...).sort((a, b) => a.label.localeCompare(b.label))` in Sites, OrgDirectory, InitiativeTimeline, ClientDashboard, ContainerEditModal, initiatives.ts, timeline.ts, reports.ts, labels.ts, variables.ts, generateLabels.ts, printLabels.ts, DevDatabase, OfflineCacheModal…) → `naturalCompare`.
Inventory at the time of writing: ~60 `localeCompare`/string sorts across `portal/src/pages`, `portal/src/components` and `portal/src/lib` (see `grep -rn "localeCompare\|\.sort(" portal/src | grep -v test`). The guardrail is the source of truth: it must pass with an allowlist that contains only numeric/pre-ordered cases, each with a reason.

- [ ] **Step 5: Run the tests, the two guardrails and the type check**

Run: `cd portal && npx vitest run src/lib/naturalSort.test.ts src/styles/naturalSort.test.ts src/styles/listTypography.test.ts && npx vitest run && npx tsc -b`
Expected: PASS (full portal suite included — many page tests assert row order and may need their fixtures' expected order updated to natural order; change expectations only where the new order is the natural one).

- [ ] **Step 6: Commit**

```bash
git add portal/src
git commit -m "feat(portal): natural ordering everywhere — one comparator, every string sort, and a guardrail

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Kiosk

**Files:**
- Modify: kiosk files the guardrail lists (at the time of writing: `kiosk/src/lib/peopleMatch.ts` name ordering; check `kiosk/src` for any `localeCompare`/string `.sort`)
- Test: existing kiosk tests; the portal guardrail already scans `kiosk/src`

- [ ] **Step 1: Run the guardrail** — `cd portal && npx vitest run src/styles/naturalSort.test.ts` — and fix each kiosk hit with `import { naturalCompare } from '@portal/lib/naturalSort';` (the kiosk's `portalImports.test.ts` allows React-free `.ts` from `@portal/lib`). Numeric sorts (`seq`, `exact`) stay as they are or get allowlisted.
- [ ] **Step 2:** `cd kiosk && npx vitest run && npx tsc -b`; `cd portal && npx vitest run src/styles/naturalSort.test.ts src/kiosk 2>/dev/null; npx vitest run src/styles/naturalSort.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add kiosk/src portal/src/styles/naturalSort.allow.json
git commit -m "feat(kiosk): natural ordering through the shared comparator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Full suites (controller)

```bash
cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_natsort_full .venv/bin/pytest -q
cd ../portal && npx vitest run && npx tsc -b && npm run build
cd ../kiosk && npx vitest run && npx tsc -b
```
