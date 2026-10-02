# Router Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show router names on `/hardware/routers` human-readable (`csg_router_kit_19` → `CSG Router Kit 19`) without changing the stored name.

**Architecture:** One pure helper `routerDisplayName` in `portal/src/lib/devices.ts`; the Routers page uses it for the Name cell, sort, column filter, search, confirm dialogs and CSV. No API or database change.

**Tech Stack:** React + TypeScript + Vitest (portal/).

Spec: `docs/superpowers/specs/2026-10-02-router-display-name-design.md`.

## Global Constraints

- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/router-display-name`, branch `router-display-name`. Never commit on main.
- `ROUTER_ACRONYMS = ['csg', 'gl', 'vpn', 'lte', 'nap', 'dc', 'ups', 'lan', 'wan', 'ap']`.
- Rules: split on runs of `_`, `-`, `.`, whitespace; acronym → UPPERCASE; a word containing any digit → unchanged as typed; otherwise first char upper + rest lower; join with single spaces; empty result → return the input unchanged.
- Examples (exact): `csg_router_kit_19` → `CSG Router Kit 19`; `GL-MT3000` → `GL MT3000`; `dock__router--2` → `Dock Router 2`; `CSG_ROUTER_KIT` → `CSG Router Kit`; `''` → `''`.
- Scope: `/hardware/routers` only. Do not change `deviceCellText`, `deviceSearchText`, `deviceSortValue`, Kiosk Devices or Fixed Readers.
- No `localeCompare`, `Intl.Collator`, bare `.sort()`/`.toSorted()` (guardrail `portal/src/styles/naturalSort.test.ts`).
- Commands from `portal/`: `npx vitest run <files>`, `npx tsc -b`, full `npx vitest run` at the end.
- Commit trailer exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. American English.

---

### Task 1: The helper

**Files:**
- Modify: `portal/src/lib/devices.ts` (add after the existing exported label helpers)
- Test: `portal/src/lib/devices.test.ts`

**Interfaces:**
- Produces: `export const ROUTER_ACRONYMS: readonly string[]`; `export function routerDisplayName(name: string): string`.

- [ ] **Step 1: Write the failing tests** — append to `portal/src/lib/devices.test.ts` (add `routerDisplayName` to its import from `./devices`):

```ts
describe('routerDisplayName', () => {
  it.each([
    ['csg_router_kit_19', 'CSG Router Kit 19'],
    ['GL-MT3000', 'GL MT3000'],
    ['dock__router--2', 'Dock Router 2'],
    ['CSG_ROUTER_KIT', 'CSG Router Kit'],
    ['nap.14 vpn  gateway', 'NAP 14 VPN Gateway'],
    ['Csg_Lan_ap_1', 'CSG LAN AP 1'],
    ['kit19_mt3000', 'kit19 mt3000'],
  ])('%s → %s', (raw, shown) => {
    expect(routerDisplayName(raw)).toBe(shown);
  });

  it('returns the input when nothing readable is left', () => {
    expect(routerDisplayName('')).toBe('');
    expect(routerDisplayName('__--')).toBe('__--');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd portal && npx vitest run src/lib/devices.test.ts`
Expected: FAIL — `routerDisplayName` is not exported.

- [ ] **Step 3: Implement** in `portal/src/lib/devices.ts`:

```ts
/** Words a router hostname spells in capitals ("csg" → "CSG"). */
export const ROUTER_ACRONYMS: readonly string[] = [
  'csg', 'gl', 'vpn', 'lte', 'nap', 'dc', 'ups', 'lan', 'wan', 'ap',
];

/** A router's hostname made readable for the Routers page:
 *  `csg_router_kit_19` → "CSG Router Kit 19". Display only — the stored
 *  name stays the real hostname. Acronyms in ROUTER_ACRONYMS go to
 *  capitals; a word with any digit in it (19, MT3000) is kept as typed;
 *  every other word gets a capital first letter. */
export function routerDisplayName(name: string): string {
  const words = name.split(/[\s_.-]+/).filter(Boolean).map((w) => {
    if (ROUTER_ACRONYMS.includes(w.toLowerCase())) return w.toUpperCase();
    if (/\d/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
  return words.length ? words.join(' ') : name;
}
```

- [ ] **Step 4: Run tests**

Run: `cd portal && npx vitest run src/lib/devices.test.ts && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/devices.ts portal/src/lib/devices.test.ts
git commit -m "feat(portal): routerDisplayName — readable router hostnames

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Routers page uses it

**Files:**
- Modify: `portal/src/pages/Routers.tsx` (imports ~line 27; `deviceCellTextTyped` ~line 66; `CSV_COLUMNS` ~line 68; `searchText` ~line 139; sort ~line 180; confirm dialogs ~lines 206–235; `cellFor` ~line 255; header comment)
- Test: `portal/src/pages/Routers.test.tsx`

**Interfaces:**
- Consumes: `routerDisplayName(name: string): string` from `../lib/devices` (Task 1).

- [ ] **Step 1: Write the failing tests** — append to `portal/src/pages/Routers.test.tsx`. Read the file's top first and reuse its existing device fixture builder, `listDevices` mock and render helper (the existing "Delete from the row menu confirms, deletes and reloads" test shows how to open a row's Actions menu and spy on `window.confirm`). Write these tests with the file's real helpers:

```tsx
it('shows a router hostname readable, with the raw name on hover', async () => {
  // mock listDevices → [ <router fixture> with name: 'csg_router_kit_19' ]
  // render the page
  const cell = await screen.findByText('CSG Router Kit 19');
  expect(cell.getAttribute('title')).toBe('csg_router_kit_19');
  expect(screen.queryByText('csg_router_kit_19')).toBeNull();
});

it('search finds a router by its readable name or its raw hostname', async () => {
  // mock listDevices → [ router 'csg_router_kit_19', router 'dock_router_2' ]
  // render; type 'csg_router' into the page's search box (use the same query the file's
  // other search tests use, or getByPlaceholderText/getByRole('searchbox') as the page renders it)
  // expect 'CSG Router Kit 19' visible and 'Dock Router 2' absent
  // clear the box and type 'Router Kit 19'
  // expect 'CSG Router Kit 19' visible and 'Dock Router 2' absent
});

it('confirm dialogs name the router readably', async () => {
  // mock listDevices → [ router 'csg_router_kit_19' ]; spy window.confirm → false
  // render, open its Actions menu, click Delete
  // expect(confirm).toHaveBeenCalledWith('Delete "CSG Router Kit 19"? This cannot be undone.')
});

it('sorts by the readable name in natural order', async () => {
  // mock listDevices → routers 'csg_router_kit_10', 'csg_router_kit_2'
  // render (default sort is name asc); the row order must be 'CSG Router Kit 2' then 'CSG Router Kit 10'
});
```

Every comment above must become real code; no placeholder may remain. If the page has no search box the tests can reach, say so in your report instead of skipping silently.

- [ ] **Step 2: Run to verify they fail**

Run: `cd portal && npx vitest run src/pages/Routers.test.tsx`
Expected: the four new tests FAIL (raw names shown).

- [ ] **Step 3: Implement** in `Routers.tsx`:

Import `routerDisplayName` from `../lib/devices`. Add a page-local cell-text function and use it for column filters:

```tsx
/** The Routers page's cell text: the Name column is the readable name. */
const routerCellText = (d: DeviceItem, key: string): string =>
  key === 'name' ? routerDisplayName(d.name) : deviceCellText(d, key);

const deviceCellTextTyped: CellText<DeviceItem> = (d, key) => routerCellText(d, key);
```

CSV: replace `['Name', (d) => d.name],` with:

```tsx
  ['Name', (d) => routerDisplayName(d.name)],
  ['Hostname', (d) => d.name],
```

Search (keep the raw name too):

```tsx
  const searchText = (d: DeviceItem) =>
    `${routerDisplayName(d.name)} ${deviceSearchText(d)}`.toLowerCase();
```

Sort — in the `visible` memo replace the comparator's value function:

```tsx
      const sortValue = (d: DeviceItem) =>
        sortKey === 'name' ? routerDisplayName(d.name).toLowerCase() : deviceSortValue(d, sortKey);
      const va = sortValue(a), vb = sortValue(b);
```

Confirm dialogs: in each of the Delete / Approve (both variants) / dismiss-warning / Revoke messages replace `${d.name}` with `${routerDisplayName(d.name)}`. Any notice/error message on this page that names the router likewise.

Name cell — add a case to `cellFor` before `default:`:

```tsx
      case 'name': {
        const text = routerDisplayName(d.name);
        return <span className="cell-line" title={d.name}>{text}</span>;
      }
```

(Read the `default:` branch first and keep the same class names; the only differences are the text and the `title`.)

Header comment: add one line — "Names show readable (routerDisplayName: csg_router_kit_19 → CSG Router Kit 19); the stored name stays the hostname, shown on hover and in the CSV's Hostname column."

- [ ] **Step 4: Run tests**

Run: `cd portal && npx vitest run src/pages/Routers.test.tsx src/lib/devices.test.ts src/styles && npx tsc -b`, then the full `npx vitest run`.
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/Routers.tsx portal/src/pages/Routers.test.tsx
git commit -m "feat(portal): Routers page shows readable router names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
