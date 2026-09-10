# List Typography Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every row-based surface in the portal uses the Assets list's typography via one token layer and three primitives, a Settings "List text size" preference scales them (Small/Default/Large/Extra large), and a guardrail test prevents re-divergence — per docs/superpowers/specs/2026-09-09-list-typography-design.md.

**Architecture:** `directory.css` declares `--list-*` tokens on `.portal-shell` (scaled by `--list-scale` from `data-list-size`, density overriding row tokens) and owns the ONLY typography for three primitives: directory list (existing `.dir-list` family), mini list (new `.mini-list/.mini-row`), data table (new `<DataTable>` → `table.data-table`). A guardrail vitest scans the source tree; an allowlist JSON seeded with today's violations shrinks to one deliberate entry as each migration wave lands.

**Tech Stack:** React + CSS custom properties; vitest (node env for the guardrail, jsdom for components); FastAPI/pydantic for the preference.

## Global Constraints

- Scale factors (verbatim): `small` 0.9, `default` 1, `large` 1.15, `xlarge` 1.3. `Default` must be pixel-identical to today's Assets list.
- Golden values (verbatim, all become tokens): head mono 10px / 42px tall; primary 14px/600; primary-sub mono 11.5px; cell 13.5px; sub 12px/300; mono 12px; chip 12px/500 24px tall; chip.tag mono 11px; kv label 12.5px/300; kv value 13px; row min-height 66px, padding-y 12px (compact 52px / 8px); mini row min-height 44px (compact 38px); avatar 38px (compact 30px, initials 13px/11px).
- Font families never change with size: display font for names/values, `var(--font-mono)` for identifiers.
- Page stylesheets may set LAYOUT only for list content (grid columns, widths, alignment, gaps, colors) — never `font-size`, `font-family`, `font-weight`, `line-height`, `min-height` on list-ish selectors.
- Preference: `list_size: Literal["small","default","large","xlarge"] = "default"`; shell attribute `data-list-size`; Settings copy: row title `List text size`, sub-copy `Scales every list and table — pick what reads best on your screen.`, buttons `Small` / `Default` / `Large` / `Extra large`.
- Guardrail allowlist file: `portal/src/styles/listTypography.allow.json`; every entry has a `reason`.
- Tests: portal from `portal/` via `npx vitest run …` (node_modules is a symlink in this worktree — fine); API from `api/` via `SS_TEST_DB=serversherpa_test_lt .venv/bin/python -m pytest …` (a private test DB; conftest creates it). FOREGROUND, one continuous call, timeout 600000ms, never background.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py` (only if it shows modified).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Existing page tests must keep passing WITHOUT weakening: migrations keep the same visible text/labels; only classNames/structure change.

---

### Task 1: Token layer + guardrail (enforced from day one via a baseline allowlist)

**Files:**
- Modify: `portal/src/styles/directory.css` (`.list-head` ~167, `.row-main` ~203, `.cell-primary .pn b/span` ~218–237, `.cell .cell-top/.cell-sub/.mono` ~240–252, `.dir-avatar` ~289, `.chip` ~305, `.chip.tag` ~402, `.kv dt/dd` ~450–452, compact block ~494–497)
- Create: `portal/src/styles/listTypography.test.ts`, `portal/src/styles/listTypography.allow.json`

**Interfaces:**
- Produces: CSS tokens `--list-scale`, `--list-fs-head`, `--list-fs-primary`, `--list-fs-primary-sub`, `--list-fs-cell`, `--list-fs-sub`, `--list-fs-mono`, `--list-fs-chip`, `--list-fs-chip-tag`, `--list-fs-kv-label`, `--list-fs-kv-value`, `--list-fs-avatar`, `--list-row-min-h`, `--list-row-pad-y`, `--list-head-h`, `--list-mini-row-min-h`, `--list-chip-h`, `--list-avatar`; attribute contract `.portal-shell[data-list-size=small|large|xlarge]`. The guardrail's allowlist format `{ file, selector?, reason }[]`. Every later task removes its family's baseline entries.

- [ ] **Step 1: Write the guardrail test** — `portal/src/styles/listTypography.test.ts`:

```ts
/**
 * Guardrail: list typography lives ONLY in directory.css, as tokens.
 * (a) no other stylesheet sets font-size/font-family/font-weight/
 *     line-height/min-height on a list-ish selector;
 * (b) no page/component renders a raw <table> (use <DataTable>);
 * (c) directory.css list rules use var(--list-…) tokens, never literal px,
 *     for those properties.
 * Deliberate exceptions live in listTypography.allow.json with a reason.
 * Violations print a ready-to-paste allowlist snippet — but the fix is
 * almost always to use the tokens/primitives, not to allowlist.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const LIST_SELECTOR = /(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head)/i;
const TYPO_PROPS = /^(font-size|font-family|font-weight|line-height|min-height)\s*:/;
const DIRECTORY_LIST_RULE = /\.(dir-list|list-head|dir-row|row-main|cell|chip|kv|mini-|data-table)/;

interface Allow { file: string; selector?: string; reason: string; }
const allow: Allow[] = JSON.parse(
  readFileSync(join(__dirname, 'listTypography.allow.json'), 'utf8'));
const allowed = (file: string, selector?: string) =>
  allow.some((a) => a.file === file && (a.selector === undefined || a.selector === selector));

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Flat (selector, declarations[]) pairs; nested @media wrappers are
 *  consumed innermost-first by the regex, leaving empty wrappers. */
function rules(css: string): { selector: string; decls: string[] }[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; decls: string[] }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean);
    out.push({ selector, decls });
  }
  return out;
}

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const snippet = (items: Allow[]) => JSON.stringify(items, null, 2);

describe('list typography guardrail', () => {
  it('(a) only directory.css sets typography on list-ish selectors', () => {
    const bad: Allow[] = [];
    for (const file of walk(join(SRC, 'styles'), /\.css$/)) {
      const f = rel(file);
      if (f === 'styles/directory.css') continue;
      for (const r of rules(readFileSync(file, 'utf8'))) {
        if (!LIST_SELECTOR.test(r.selector)) continue;
        if (!r.decls.some((d) => TYPO_PROPS.test(d))) continue;
        if (!allowed(f, r.selector)) bad.push({ file: f, selector: r.selector, reason: '' });
      }
    }
    expect(bad, `list typography outside directory.css:\n${snippet(bad)}`).toEqual([]);
  });

  it('(b) no raw <table> outside components/DataTable.tsx', () => {
    const bad: Allow[] = [];
    for (const dir of ['pages', 'components']) {
      for (const file of walk(join(SRC, dir), /\.tsx$/)) {
        const f = rel(file);
        if (f === 'components/DataTable.tsx') continue;
        if (/<table\b/.test(readFileSync(file, 'utf8')) && !allowed(f)) {
          bad.push({ file: f, reason: '' });
        }
      }
    }
    expect(bad, `raw <table> (use <DataTable>):\n${snippet(bad)}`).toEqual([]);
  });

  it('(c) directory.css list rules use tokens, not literal px, for typography', () => {
    const bad: string[] = [];
    for (const r of rules(readFileSync(join(SRC, 'styles/directory.css'), 'utf8'))) {
      if (!DIRECTORY_LIST_RULE.test(r.selector)) continue;
      for (const d of r.decls) {
        if (TYPO_PROPS.test(d) && /\d(px|pt)\b/.test(d) && !/var\(--list-/.test(d)
            && !allowed('styles/directory.css', r.selector)) {
          bad.push(`${r.selector} { ${d} }`);
        }
      }
    }
    expect(bad, `literal sizes in directory.css list rules:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    expect(allow.filter((a) => !a.reason.trim())).toEqual([]);
  });
});
```

Create `portal/src/styles/listTypography.allow.json` as `[]`.

- [ ] **Step 2: Run it — expect (a), (b), (c) to FAIL** with printed lists: `npx vitest run src/styles/listTypography.test.ts`. Keep the (a) and (b) output — it is the baseline.

- [ ] **Step 3: Tokens in directory.css.** Insert at the top of the file (after the header comment):

```css
/* ── list typography tokens ────────────────────────────────────────
   The Assets list is the golden template; every list-like surface
   (directory list, mini list, data table) draws its sizes from these
   tokens and page stylesheets set LAYOUT ONLY — enforced by
   listTypography.test.ts. --list-scale comes from the user's Settings →
   List text size; density overrides the row-height tokens on top. */
.portal-shell { --list-scale: 1; }
.portal-shell[data-list-size='small']  { --list-scale: 0.9; }
.portal-shell[data-list-size='large']  { --list-scale: 1.15; }
.portal-shell[data-list-size='xlarge'] { --list-scale: 1.3; }
.portal-shell {
  --list-fs-head: calc(10px * var(--list-scale));
  --list-fs-primary: calc(14px * var(--list-scale));
  --list-fs-primary-sub: calc(11.5px * var(--list-scale));
  --list-fs-cell: calc(13.5px * var(--list-scale));
  --list-fs-sub: calc(12px * var(--list-scale));
  --list-fs-mono: calc(12px * var(--list-scale));
  --list-fs-chip: calc(12px * var(--list-scale));
  --list-fs-chip-tag: calc(11px * var(--list-scale));
  --list-fs-kv-label: calc(12.5px * var(--list-scale));
  --list-fs-kv-value: calc(13px * var(--list-scale));
  --list-fs-avatar: calc(13px * var(--list-scale));
  --list-row-min-h: calc(66px * var(--list-scale));
  --list-row-pad-y: calc(12px * var(--list-scale));
  --list-head-h: calc(42px * var(--list-scale));
  --list-mini-row-min-h: calc(44px * var(--list-scale));
  --list-chip-h: calc(24px * var(--list-scale));
  --list-avatar: calc(38px * var(--list-scale));
}
.portal-shell[data-density='compact'] {
  --list-row-min-h: calc(52px * var(--list-scale));
  --list-row-pad-y: calc(8px * var(--list-scale));
  --list-mini-row-min-h: calc(38px * var(--list-scale));
  --list-avatar: calc(30px * var(--list-scale));
  --list-fs-avatar: calc(11px * var(--list-scale));
}
```

Then replace literals in the golden rules (exact substitutions):
- `.list-head`: `height: 42px` → `height: var(--list-head-h)`; `font-size: 10px` → `font-size: var(--list-fs-head)`.
- `.list-head .sortable .caret { font-size: 9px }` → `font-size: calc(var(--list-fs-head) * 0.9)`.
- `.row-main`: `padding: 12px 20px` → `padding: var(--list-row-pad-y) 20px`; `min-height: 66px` → `min-height: var(--list-row-min-h)`.
- `.cell-primary .pn b`: `font-size: 14px` → `var(--list-fs-primary)`. `.cell-primary .pn span`: `11.5px` → `var(--list-fs-primary-sub)`.
- `.cell .cell-top` → selector `.cell .cell-top, .mini-row .cell-top, .data-table .cell-top` with `font-size: var(--list-fs-cell)`; likewise `.cell .cell-sub, .mini-row .cell-sub, .data-table .cell-sub` (`var(--list-fs-sub)`) and `.cell .mono, .mini-row .mono, .data-table .mono` (`var(--list-fs-mono)`).
- `.dir-avatar`: `width/height: 38px` → `var(--list-avatar)`; `font-size: 13px` → `var(--list-fs-avatar)`.
- `.chip`: `height: 24px` → `var(--list-chip-h)`; `font-size: 12px` → `var(--list-fs-chip)`; `line-height: 22px` → `line-height: calc(var(--list-chip-h) - 2px)`.
- `.chip.tag`: `font-size: 11px` → `var(--list-fs-chip-tag)`.
- `.kv dt` `12.5px` → `var(--list-fs-kv-label)`; `.kv dd` `13px` → `var(--list-fs-kv-value)`; `.kv dd.mono` `12px` → `var(--list-fs-mono)`.
- Delete the two compact-density rules (`.portal-shell[data-density='compact'] .row-main {…}` and `… .dir-avatar {…}`) — the token override replaces them; keep the section comment.

- [ ] **Step 4: Seed the baseline allowlist.** Re-run the test; (c) must now pass. Paste (a)'s and (b)'s printed entries into `listTypography.allow.json`, filling every `reason` with `baseline — migrate in Task <N>` using this map: dashboard.css / components/dashboard → Task 4; access.css, system.css, `components/access/MatrixTable.tsx` → Task 5; initiatives.css, time.css, profile.css, reports.css, assets.css, sites.css bulk rows, `components/sites/SiteBulkImport.tsx`, `components/containers/ContainerBulkImport.tsx` → Task 6; hardware.css, notifications.css, `components/hardware/RouterLeases.tsx`, `components/notifications/MembersPanel.tsx`, `components/scans/ScanHistoryTable.tsx`, `pages/WorkerDetail.tsx` → Task 7. Any selector that is clearly NOT list content (a page title, a form label, a modal) gets reason `not list content: <what it is>` and stays permanently. Run `npx vitest run src/styles/listTypography.test.ts` → 4 pass. Also run `npx vitest run src/pages/Assets.test.tsx src/pages/Containers.test.tsx` → pass (no visual change at Default; tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add portal/src/styles/directory.css portal/src/styles/listTypography.test.ts portal/src/styles/listTypography.allow.json
git commit -m "feat(portal): list typography tokens + guardrail test with baseline allowlist"
```

---

### Task 2: Primitives — mini list CSS and `<DataTable>`

**Files:**
- Modify: `portal/src/styles/directory.css` (append a "mini list" and "data table" section after the `.kv` rules)
- Create: `portal/src/components/DataTable.tsx`, `portal/src/components/DataTable.test.tsx`

**Interfaces:**
- Produces:
```ts
export interface DataTableColumn { key: string; label: ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; width?: string; }
export interface DataTableRow { key: string; cells: ReactNode[]; className?: string; }
export default function DataTable(props: { columns: DataTableColumn[]; rows: DataTableRow[]; className?: string; emptyText?: string; ariaLabel?: string }): JSX.Element
```
Markup: `<table class="data-table {className}">` + `<colgroup>` (widths) + `<thead><tr><th class="{align}">…` + `<tbody>` rows of `<td class="{align} {mono?'mono':''}">`; when `rows` is empty renders one `<td colSpan class="data-table-empty">{emptyText ?? 'Nothing here yet.'}</td>`. CSS classes `.mini-list`, `.mini-row`, `.mini-list-head`, `.data-table` (+ `th`, `td`, `.data-table-empty`). Tasks 4–7 consume these.

- [ ] **Step 1: Write the failing test** — `DataTable.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DataTable from './DataTable';

afterEach(cleanup);

describe('DataTable', () => {
  it('renders head/body with alignment and mono classes', () => {
    render(<DataTable ariaLabel="Leases"
      columns={[{ key: 'host', label: 'Hostname' }, { key: 'mac', label: 'MAC', mono: true, align: 'right', width: '140px' }]}
      rows={[{ key: 'r1', cells: ['nas-1', 'AA:BB'] }]} />);
    const table = screen.getByRole('table', { name: 'Leases' });
    expect(table.className).toContain('data-table');
    expect(screen.getByText('Hostname').tagName).toBe('TH');
    const mac = screen.getByText('AA:BB');
    expect(mac.tagName).toBe('TD');
    expect(mac.className).toContain('mono');
    expect(mac.className).toContain('right');
    expect(table.querySelector('col')?.getAttribute('style')).toContain('140px');
  });
  it('renders the empty row', () => {
    render(<DataTable columns={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} rows={[]} emptyText="No leases." />);
    const empty = screen.getByText('No leases.');
    expect(empty.getAttribute('colspan')).toBe('2');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/DataTable.test.tsx`.

- [ ] **Step 3: Implement** — `components/DataTable.tsx`:

```tsx
/**
 * DataTable — the ONE sanctioned <table> in the portal (guardrail:
 * styles/listTypography.test.ts). Genuinely tabular data (matrices,
 * leases, import previews) renders here so header/cell typography comes
 * from directory.css's list tokens; callers pass layout (widths,
 * alignment, mono) as props and never style td/th themselves.
 */
import type { ReactNode } from 'react';

export interface DataTableColumn {
  key: string; label: ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; width?: string;
}
export interface DataTableRow { key: string; cells: ReactNode[]; className?: string; }

export default function DataTable({ columns, rows, className, emptyText, ariaLabel }: {
  columns: DataTableColumn[]; rows: DataTableRow[]; className?: string;
  emptyText?: string; ariaLabel?: string;
}) {
  const cls = (c: DataTableColumn) => [c.align ?? 'left', c.mono ? 'mono' : ''].join(' ').trim();
  return (
    <table className={`data-table ${className ?? ''}`.trim()} aria-label={ariaLabel}>
      <colgroup>
        {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>{columns.map((c) => <th key={c.key} className={c.align ?? 'left'}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td className="data-table-empty" colSpan={columns.length}>{emptyText ?? 'Nothing here yet.'}</td></tr>
        ) : rows.map((r) => (
          <tr key={r.key} className={r.className}>
            {r.cells.map((cell, i) => <td key={columns[i]?.key ?? i} className={cls(columns[i])}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`directory.css` — append:

```css
/* ── mini list: header-less compact rows (dashboard feeds, embedded
   panels, pickers). Reuses the cell classes so typography IS the golden
   tokens; pages set grid-template-columns and nothing else. ───────── */
.mini-list { display: flex; flex-direction: column; min-width: 0; }
.mini-row {
  display: grid;
  align-items: center;
  gap: 12px;
  min-height: var(--list-mini-row-min-h);
  padding: calc(var(--list-row-pad-y) * 0.5) 0;
  border-bottom: 1px solid var(--paper-line);
  min-width: 0;
}
.mini-row:last-child { border-bottom: 0; }
.mini-list-head {
  display: grid;
  gap: 12px;
  padding: 0 0 6px;
  font-family: var(--font-mono);
  font-size: var(--list-fs-head);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-mute);
}

/* ── data table: the only <table> (components/DataTable.tsx) ───────── */
.data-table { width: 100%; border-collapse: collapse; }
.data-table th {
  text-align: left;
  padding: 0 12px;
  height: var(--list-head-h);
  background: var(--surface-2);
  border-bottom: 1px solid var(--paper-line);
  font-family: var(--font-mono);
  font-size: var(--list-fs-head);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-mute);
  white-space: nowrap;
}
.data-table td {
  padding: calc(var(--list-row-pad-y) * 0.5) 12px;
  height: var(--list-mini-row-min-h);
  border-bottom: 1px solid var(--paper-line);
  font-size: var(--list-fs-cell);
  color: var(--text-dark);
  vertical-align: middle;
}
.data-table tr:last-child td { border-bottom: 0; }
.data-table td.mono, .data-table th.mono { font-family: var(--font-mono); font-size: var(--list-fs-mono); color: var(--text-mute); }
.data-table .right { text-align: right; }
.data-table .center { text-align: center; }
.data-table .data-table-empty { color: var(--text-mute); font-size: var(--list-fs-sub); text-align: center; }
```

- [ ] **Step 4: Run** — `npx vitest run src/components/DataTable.test.tsx src/styles/listTypography.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/DataTable.tsx portal/src/components/DataTable.test.tsx portal/src/styles/directory.css
git commit -m "feat(portal): mini-list and DataTable primitives on the list tokens"
```

---

### Task 3: Preference — API `list_size`, portal apply, Settings row

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`UiPreferences`, ~line 59)
- Modify: `portal/src/lib/api.ts` (`UiPreferences` ~52), `portal/src/lib/settings.ts` (defaults ~13; `applyPreferences` ~62), `portal/src/pages/Settings.tsx` (after the Interface density row ~114)
- Test: `api/tests/test_preferences.py`, `portal/src/lib/settings.test.ts` (create), `portal/src/pages/Settings.test.tsx` (create)

**Interfaces:**
- Produces: `UiPreferences.list_size: 'small' | 'default' | 'large' | 'xlarge'` (API + portal), `applyPreferences` sets `data-list-size`. Task 8 verifies live.

- [ ] **Step 1: Failing tests.**

`api/tests/test_preferences.py` — append (reuse the file's existing login/PUT helpers; the PUT endpoint is `/auth/me/preferences`):

```python
async def test_list_size_round_trips_and_defaults(client, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/auth/me", headers=hdrs)
    assert resp.json()["preferences"]["list_size"] == "default"
    prefs = {**resp.json()["preferences"], "list_size": "xlarge"}
    resp = await client.put("/auth/me/preferences", headers=hdrs, json=prefs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["list_size"] == "xlarge"
    resp = await client.put("/auth/me/preferences", headers=hdrs,
                            json={**prefs, "list_size": "huge"})
    assert resp.status_code == 422
```

(Match the file's actual helper names/response shape — read its first test.)

`portal/src/lib/settings.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, applyPreferences } from './settings';

describe('applyPreferences list size', () => {
  it('stamps data-list-size on the shell', () => {
    const shell = document.createElement('div');
    shell.className = 'portal-shell';
    document.body.appendChild(shell);
    applyPreferences({ ...DEFAULT_PREFERENCES, list_size: 'large' }, shell);
    expect(shell.getAttribute('data-list-size')).toBe('large');
    expect(DEFAULT_PREFERENCES.list_size).toBe('default');
  });
});
```

(Adapt to `applyPreferences`'s real signature — read lib/settings.ts; if it looks the shell up itself, mount the div and call with prefs only.)

`portal/src/pages/Settings.test.tsx` (mock `../auth/AuthContext` like `layout/AppShell.test.tsx` does, with `updatePreferences: vi.fn(async () => true)` and `can: () => false`):

```tsx
it('List text size row updates the preference', async () => {
  render(<Settings />);
  expect(screen.getByText('List text size')).toBeTruthy();
  fireEvent.click(screen.getByText('Extra large'));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ list_size: 'xlarge' })));
});
```

- [ ] **Step 2: Run to verify failure** — API file + the two portal files.

- [ ] **Step 3: Implement.** `schemas.py` `UiPreferences`: add `list_size: Literal["small", "default", "large", "xlarge"] = "default"` after `density`. Portal `lib/api.ts`: `list_size: 'small' | 'default' | 'large' | 'xlarge';` after `density`. `lib/settings.ts`: default `list_size: 'default'` beside `density: 'comfortable'`; in `applyPreferences` after the density line: `shell.setAttribute('data-list-size', prefs.list_size ?? 'default');`. Fix any `UiPreferences` literals in tests that now miss the field (grep `density: 'comfortable'` across `portal/src` and add `list_size: 'default'`). `Settings.tsx` — after the Interface density row:

```tsx
          <div className="set-row">
            <div className="set-label">
              <b>List text size</b>
              <span>Scales every list and table — pick what reads best on your screen.</span>
            </div>
            <div className="seg-mini">
              {([['small', 'Small'], ['default', 'Default'], ['large', 'Large'], ['xlarge', 'Extra large']] as const).map(([key, label]) => (
                <button key={key} className={preferences.list_size === key ? 'on' : ''}
                        onClick={() => update({ list_size: key })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 4: Run** — `SS_TEST_DB=serversherpa_test_lt .venv/bin/python -m pytest tests/test_preferences.py -q`; `npx vitest run src/lib/settings.test.ts src/pages/Settings.test.tsx src/layout && npx tsc --noEmit -p .` → pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/tests/test_preferences.py portal/src/lib/api.ts portal/src/lib/settings.ts portal/src/lib/settings.test.ts portal/src/pages/Settings.tsx portal/src/pages/Settings.test.tsx
git commit -m "feat: list text size preference (API + Settings + shell attribute)"
```

---

### Migration waves (Tasks 4–7) — the shared recipe

Each wave converts the families listed for it and ends with **their baseline entries deleted from `listTypography.allow.json` and the guardrail green**. The recipe, applied per family:

1. Open the family's CSS rules (selectors listed per task). Delete every `font-size`, `font-family`, `font-weight`, `line-height`, `min-height` declaration from list-content rules. Keep layout: `display:grid`, `grid-template-columns`, `gap`, `padding-x`, widths, colors, borders, alignment.
2. Convert the markup to a primitive:
   - Rows with a name + secondary line + a few values → **mini list**: container gets `mini-list`, each row `mini-row` + the family's existing layout class (kept ONLY for `grid-template-columns`); the name becomes `<div className="cell-primary"><div className="pn"><b>{name}</b><span>{sub}</span></div></div>`; plain values `<span className="cell-top">`, secondary `<span className="cell-sub">`, identifiers/timestamps `<span className="mono">`, statuses `<span className="chip …">`. If the panel had column labels, keep them as `<div className="mini-list-head {layoutClass}">`.
   - Column-labelled grids of homogeneous cells / anything using `<table>` → **`<DataTable>`** (`import DataTable from '../DataTable'` or `'../../components/DataTable'`), mapping headers to `columns` (`mono: true` for identifier columns, `align: 'right'` for numbers) and each row to `{ key, cells }`. Interactive cells (toggles, buttons) are just ReactNodes in `cells`.
   - Rows that already have a column header and full-width directory semantics → **directory list** (`dir-list`/`list-head`/`dir-row`/`row-main` + the family's grid class for columns).
3. Keep every visible string exactly (tests assert on text). Re-run that page's tests.
4. Remove the family's entries from the allowlist; run the guardrail.

Worked example (mini list) — before, `time.css` + `TimeManagement.tsx`:
```tsx
<div className="time-recent-list">
  <div className="time-recent-row"><b className="time-name">{e.person_name}</b><span className="time-when">{fmt(e.at)}</span><span className="chip c-green">{e.status_label}</span></div>
```
```css
.time-recent-row { display:grid; grid-template-columns: 1fr 120px 100px; gap: 10px; padding: 8px 0; font-size: 12.5px; }
.time-recent-row .time-name { font-size: 13px; font-weight: 600; }
.time-recent-row .time-when { font-family: var(--font-mono); font-size: 11px; color: var(--text-mute); }
```
after:
```tsx
<div className="mini-list time-recent-list">
  <div className="mini-row time-recent-row"><div className="cell-primary"><div className="pn"><b>{e.person_name}</b></div></div><span className="mono">{fmt(e.at)}</span><span className="chip c-green">{e.status_label}</span></div>
```
```css
.time-recent-row { grid-template-columns: 1fr 120px 100px; }
```

Worked example (DataTable) — `RouterLeases.tsx`:
```tsx
<DataTable ariaLabel="DHCP leases" emptyText="No leases reported."
  columns={[{ key: 'up', label: 'Up', width: '44px', align: 'center' }, { key: 'host', label: 'Hostname' }, { key: 'ip', label: 'IP', mono: true }, { key: 'mac', label: 'MAC', mono: true }, { key: 'seen', label: 'Last seen', mono: true }]}
  rows={leases.map((l) => ({ key: l.id, cells: [<span className={`lease-dot ${l.up ? 'up' : ''}`} />, l.hostname ?? '—', l.ip ?? '—', l.mac, formatAge(l.last_seen_at, now)] }))} />
```
with `hardware.css` keeping only `.lease-dot` layout/colors and dropping every `.lease-table` typography rule.

### Task 4: Wave 1 — dashboards

**Files:** `portal/src/styles/dashboard.css`; `portal/src/pages/Home.tsx`, `MoveDashboard.tsx`, `PeopleDashboard.tsx`, `ClientDashboard.tsx`; `portal/src/components/dashboard/*.tsx` (whichever render the families). Families: `dash-board-row(s)`, `dash-dist-row(s)`, `dash-feed-row`, `dash-scan-list/row`, `dash-grid-line`, `mdash-wave-row`, `pdash-clock-row` (+ delete its `.dir-avatar` override — the avatar token handles size), `cdash-act-row`, `cdash-init-row`. Tests: `src/pages/Home.test.tsx`, `MoveDashboard.test.tsx`, `PeopleDashboard.test.tsx`, `ClientDashboard.test.tsx`, `src/components/dashboard/*.test.tsx`.

- [ ] Step 1: For each family, note its selectors' typography decls (`grep -n "font-\|min-height\|line-height" styles/dashboard.css`).
- [ ] Step 2: Apply the recipe (mini list for all of these — dashboard rows are header-less feeds; `dash-dist-row` legend rows use `cell-top` + `mono` for counts).
- [ ] Step 3: Delete the Task-4 baseline entries from `listTypography.allow.json`.
- [ ] Step 4: `npx vitest run src/pages/Home.test.tsx src/pages/MoveDashboard.test.tsx src/pages/PeopleDashboard.test.tsx src/pages/ClientDashboard.test.tsx src/components/dashboard src/styles/listTypography.test.ts && npx tsc --noEmit -p .` → pass.
- [ ] Step 5: Commit `refactor(portal): dashboards on the mini-list primitive`.

### Task 5: Wave 2 — access + system

**Files:** `portal/src/styles/access.css`, `system.css`; `portal/src/components/access/MatrixTable.tsx` (→ `<DataTable>`; `pm-cell`/`pm-col-head`/`pm-res-label` keep layout classes on the ReactNode cells only), `components/access/*` rendering `mem-row`/`gate-row` (→ mini list), `pages/SystemProcesses.tsx` (`sys-proc-list` → directory list: it has a head), `pages/System*.tsx`/`components/system/*` rendering `envtab-*`, `sysconf-row` (→ mini list). Tests: `src/pages/Access*.test.tsx`, `src/components/access/*.test.tsx`, `src/pages/SystemProcesses.test.tsx`, `src/pages/System*.test.tsx`.

- [ ] Steps 1–5 as the recipe; allowlist entries for Task 5 removed; commit `refactor(portal): access + system lists on the shared primitives`.

### Task 6: Wave 3 — initiatives, time, profile, reports, assets, bulk-import previews

**Files:** `initiatives.css` (`idet-time-list/-head/-row` → mini list w/ `mini-list-head`; `idet-donut-legend-row` → mini list; `imp-missing-list/-row` → mini list), `time.css` (`time-active-list/-row`, `time-recent-list/-row`, `time-row-static`, `time-row-actions` → mini list), `profile.css` (`activity-list` → mini list), `reports.css` (`ini-picker-list/-row`, `report-section-row` → mini list), `assets.css` (`nf-list` → mini list), `sites.css` (`bulk-row-*` → `<DataTable>` row classNames for the create/update/error/unchanged tints — colors stay in sites.css). Markup: `pages/InitiativeDetail.tsx`, `pages/ImportMoveAssets.tsx`, `pages/TimeManagement.tsx` (+ `components/time/*`), `pages/Profile.tsx`/`Me.tsx` activity, `pages/Reports.tsx` (+ `components/reports/*`), `pages/Assets.tsx` `nf-list`, `components/sites/SiteBulkImport.tsx`, `components/containers/ContainerBulkImport.tsx`. Tests: the matching `*.test.tsx` files.

- [ ] Steps 1–5 as the recipe; allowlist entries for Task 6 removed; commit `refactor(portal): initiative/time/profile/report/import lists on the shared primitives`.

### Task 7: Wave 4 — remaining tables + golden-class overrides + final allowlist

**Files:** `components/hardware/RouterLeases.tsx` + `hardware.css` (`lease-table`), `components/notifications/MembersPanel.tsx` + `notifications.css` (`ngd-members-table`; `ngd-switch-row` is a form row — allowlist permanently with reason `not list content: switch row`), `components/scans/ScanHistoryTable.tsx`, `pages/WorkerDetail.tsx` (its `<table>`), all → `<DataTable>`. Delete `sites.css .site-map-detail-head .pn b { font-size: 15px }`'s baseline entry by converting it to a permanent allowlist entry with reason `detail heading, not a list row (15px title)`. After this task the allowlist contains ONLY permanent entries (each with a non-baseline reason): assert by grepping `baseline` in the JSON → no matches.

- [ ] Steps 1–5 as the recipe; commit `refactor(portal): last tables on DataTable; guardrail allowlist down to deliberate exceptions`.

---

### Task 8: Verification (controller-led)

- [ ] `grep -c baseline portal/src/styles/listTypography.allow.json` → 0.
- [ ] Full portal suite + build: `npx vitest run && npm run build`; full API suite `SS_TEST_DB=serversherpa_test_lt .venv/bin/python -m pytest -q`.
- [ ] Live (worktree portal on 5174 + worktree API on 8001 with `VITE_API_URL`): Settings → List text size → Extra large; check Assets list, a dashboard, Access matrix, a bulk-import preview scale together and Default is unchanged; Compact density still tightens rows.
- [ ] Fix, commit, fast-forward `reports`.
