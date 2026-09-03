# Rack Diagram Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Category-colored, contrast-safe rack faceplates with a solid-green verified border, a top-down device list beside the elevations, and a Letter/A4-safe print window — per docs/superpowers/specs/2026-09-02-rack-diagram-polish-design.md.

**Architecture:** Additive API fields (model category key/label/color on `InitiativeAssetSummary`), pure portal helpers in `lib/color.ts` + `lib/initiatives.ts` (contrast, list rows, legend), and a restyled `RackViewModal` whose faceplate colors are INLINE SVG attributes so the print window can serialize the live DOM without app CSS.

**Tech Stack:** FastAPI + SQLAlchemy async (existing patterns), React + vitest (`// @vitest-environment jsdom` for component tests), plain SVG.

## Global Constraints

- Verified border: solid `#15803d`, `stroke-width` 2. Planned border: `#111827`, `stroke-dasharray: 4 3` (unchanged values).
- Neutral fallback fill (no category): `#eef0f3`. Contrast threshold: luminance > 0.45 → `#111827` text, else `#ffffff`.
- Print content box: 7.2in × 10in, `@page { margin: 0.5in }` (fits Letter AND A4).
- Copy (verbatim): button `Print layout`; legend items `Verified` / `Planned`; list subheads `FRONT` / `REAR`; uncategorized legend label `Uncategorized`.
- API tests: run from `api/` with `.venv/bin/python -m pytest`. Portal tests from `portal/` with `npx vitest run`. Run suites FOREGROUND in one continuous call (timeout 600000ms) — never background.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py` (dev-reload file must never be committed dirty).
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: API — model category on initiative asset rows

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (class `InitiativeAssetSummary`, ~line 1436)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`_initiative_asset_rows`, ~line 631)
- Test: `api/tests/test_initiative_assets_api.py`

**Interfaces:**
- Produces: `InitiativeAssetSummary` JSON gains `model_category: str|null`, `model_category_label: str|null`, `model_category_color: str|null`. Task 3's portal type mirrors these names exactly.

- [ ] **Step 1: Write the failing test**

In `api/tests/test_initiative_assets_api.py`, find the test that asserts `row["asset"]["model_make"] == "Dell"` (~line 86). In its seeding section the model is created as `AssetModel(make="Dell", model="R740", ru_size=2)` — change that line to include the seeded `server` category and add assertions right after the `ru_size` assertion:

```python
    model = AssetModel(make="Dell", model="R740", ru_size=2,
                       category="server")
```

```python
    assert row["asset"]["model_category"] == "server"
    assert row["asset"]["model_category_label"] == "Server"
    assert row["asset"]["model_category_color"] == "#1668a7"
    # the model-less asset gets nulls
    bare = next(r for r in rows if r["asset"]["serial_number"] == "SN-1")
    assert bare["asset"]["model_category"] is None
    assert bare["asset"]["model_category_label"] is None
    assert bare["asset"]["model_category_color"] is None
```

(`server`/`Server`/`#1668a7` are seeded by migration 0014 — stable test data.)

- [ ] **Step 2: Run it to verify it fails**

Run (from `api/`): `.venv/bin/python -m pytest tests/test_initiative_assets_api.py -x -q`
Expected: KeyError/assertion failure on `model_category`.

- [ ] **Step 3: Implement**

`schemas.py` — append to `InitiativeAssetSummary` after `ru_size`:

```python
    model_category: str | None = None
    model_category_label: str | None = None
    model_category_color: str | None = None
```

`routes/initiatives.py` — add `AssetCategory` to the existing `from serversherpa.db.models import (...)` list (line ~27). In `_initiative_asset_rows`, after the `models = {...}` block add:

```python
    cat_keys = {m.category for m in models.values() if m.category}
    categories = {c.key: c for c in await db.scalars(
        select(AssetCategory).where(AssetCategory.key.in_(cat_keys)))} \
        if cat_keys else {}
```

In the `InitiativeAssetSummary(...)` construction, after `ru_size=...` add (with `cat = categories.get(model.category) if model and model.category else None` computed just above the `out.append` alongside `model = models.get(asset.model_id)`):

```python
                model_category=cat.key if cat else None,
                model_category_label=cat.label if cat else None,
                model_category_color=cat.color if cat else None,
```

- [ ] **Step 4: Run the file's tests**

Run: `.venv/bin/python -m pytest tests/test_initiative_assets_api.py -q` — expect all pass.

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_assets_api.py
git commit -m "feat(api): initiative asset rows expose model category key/label/color"
```

---

### Task 2: Portal — contrast helper `lib/color.ts`

**Files:**
- Create: `portal/src/lib/color.ts`
- Test: `portal/src/lib/color.test.ts`

**Interfaces:**
- Produces: `readableTextColor(hex: string): '#111827' | '#ffffff'` — Tasks 4 and 6 import it from `../../lib/color` / `./color`.

- [ ] **Step 1: Write the failing test** — `portal/src/lib/color.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { readableTextColor } from './color';

describe('readableTextColor', () => {
  it('picks dark text on light fills', () => {
    expect(readableTextColor('#eef0f3')).toBe('#111827');
    expect(readableTextColor('#FFFFFF')).toBe('#111827');
    expect(readableTextColor('#ff0')).toBe('#111827'); // 3-digit yellow
  });
  it('picks white text on dark fills', () => {
    expect(readableTextColor('#1668a7')).toBe('#ffffff'); // Server blue
    expect(readableTextColor('#6d4fc4')).toBe('#ffffff'); // Storage purple
    expect(readableTextColor('#000')).toBe('#ffffff');
  });
  it('falls back to dark text on malformed input', () => {
    expect(readableTextColor('')).toBe('#111827');
    expect(readableTextColor('tomato')).toBe('#111827');
    expect(readableTextColor('#12')).toBe('#111827');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `portal/`): `npx vitest run src/lib/color.test.ts` — expect "Cannot find module './color'".

- [ ] **Step 3: Implement** — `portal/src/lib/color.ts`:

```ts
/** WCAG-relative-luminance text-color pick for arbitrary fills (rack
 *  faceplates colored by user-managed asset-category colors). Accepts
 *  #rgb / #rrggbb (case-insensitive); anything else falls back to dark
 *  text so malformed vocab colors never produce white-on-white. */
export function readableTextColor(hex: string): '#111827' | '#ffffff' {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(hex.trim());
  if (!m) return '#111827';
  const raw = m[1] ? [...m[1]].map((c) => c + c).join('') : m[2];
  const channel = (i: number) => {
    const v = parseInt(raw.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return lum > 0.45 ? '#111827' : '#ffffff';
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/color.test.ts` — all pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/color.ts portal/src/lib/color.test.ts
git commit -m "feat(portal): readableTextColor contrast helper"
```

---

### Task 3: Portal — category plumbing, device-list rows, legend helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (interface `InitiativeAssetSummary`, ~line 1815)
- Modify: `portal/src/lib/initiatives.ts` (`RackBlock` ~line 473, `rackLayout` ~line 483; append new helpers)
- Test: `portal/src/lib/initiatives.test.ts`

**Interfaces:**
- Consumes: Task 1's API field names.
- Produces (Tasks 4–6 rely on these exact shapes):

```ts
export interface RackBlock {
  id: string; label: string; ru: number; height: number;
  verified: boolean; position: string | null;
  categoryLabel: string | null; categoryColor: string | null;
  makeModel: string;
}
export interface DeviceListRow {
  id: string; name: string; makeModel: string; ruText: string;
  categoryColor: string | null; group: 'FRONT' | 'REAR';
}
export function deviceListRows(front: RackBlock[], rear: RackBlock[]): DeviceListRow[]
export interface LegendCategory { label: string; color: string; }
export function legendCategories(blocks: RackBlock[]): LegendCategory[]
```

- [ ] **Step 1: Write the failing tests** — append to `portal/src/lib/initiatives.test.ts` (reuse the file's existing row/asset factory helpers if present; otherwise build minimal `RackBlock` literals directly — these helpers take blocks, not rows):

```ts
import { deviceListRows, legendCategories, rackLayout } from './initiatives';
import type { RackBlock } from './initiatives';

const block = (over: Partial<RackBlock>): RackBlock => ({
  id: 'b1', label: 'dev', ru: 1, height: 1, verified: false, position: null,
  categoryLabel: null, categoryColor: null, makeModel: '', ...over,
});

describe('deviceListRows', () => {
  it('sorts each group top of rack first (descending top RU), ties by name', () => {
    const front = [
      block({ id: 'a', label: 'alpha', ru: 10, height: 2 }),  // top 11
      block({ id: 'b', label: 'bravo', ru: 40, height: 1 }),  // top 40
      block({ id: 'c', label: 'chuck', ru: 9, height: 3 }),   // top 11 — tie
    ];
    const rear = [block({ id: 'r', label: 'rear-sw', ru: 50, height: 1 })];
    const rows = deviceListRows(front, rear);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c', 'r']);
    expect(rows.map((r) => r.group)).toEqual(['FRONT', 'FRONT', 'FRONT', 'REAR']);
  });
  it('formats RU ranges and model fallback', () => {
    const rows = deviceListRows(
      [block({ ru: 40, height: 3, makeModel: 'Dell R740' }),
       block({ id: 'x', ru: 1, height: 1 })], []);
    expect(rows[0].ruText).toBe('40..42');
    expect(rows[0].makeModel).toBe('Dell R740');
    expect(rows[1].ruText).toBe('1');
    expect(rows[1].makeModel).toBe('—');
  });
});

describe('legendCategories', () => {
  it('dedupes by label, sorts, and adds Uncategorized only when present', () => {
    const cats = legendCategories([
      block({ categoryLabel: 'Server', categoryColor: '#1668a7' }),
      block({ id: 'b2', categoryLabel: 'Server', categoryColor: '#1668a7' }),
      block({ id: 'b3', categoryLabel: 'Network', categoryColor: '#0f7c86' }),
      block({ id: 'b4' }), // uncategorized
    ]);
    expect(cats).toEqual([
      { label: 'Network', color: '#0f7c86' },
      { label: 'Server', color: '#1668a7' },
      { label: 'Uncategorized', color: '#eef0f3' },
    ]);
    expect(legendCategories([block({ categoryLabel: 'Power', categoryColor: '#a36207' })]))
      .toEqual([{ label: 'Power', color: '#a36207' }]);
  });
});
```

Also extend the file's existing `rackLayout` test (or add one) asserting the new block fields flow from a row whose asset has `model_make: 'Dell'`, `model_name: 'R740'`, `model_category_label: 'Server'`, `model_category_color: '#1668a7'`:

```ts
    expect(b.makeModel).toBe('Dell R740');
    expect(b.categoryLabel).toBe('Server');
    expect(b.categoryColor).toBe('#1668a7');
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/initiatives.test.ts` — type/undefined-function failures.

- [ ] **Step 3: Implement**

`api.ts` — in `interface InitiativeAssetSummary` after `ru_size: number | null;` add:

```ts
  model_category: string | null; model_category_label: string | null;
  model_category_color: string | null;
```

Fix any test factories that now miss required fields (the render test's `makeAsset` in `RackViewModal.render.test.tsx` and any other `InitiativeAssetSummary` literal — add the three nulls).

`initiatives.ts` — extend `RackBlock` with the three fields shown in Interfaces; in `rackLayout`'s `.map()` add:

```ts
      categoryLabel: r.asset.model_category_label,
      categoryColor: r.asset.model_category_color,
      makeModel: [r.asset.model_make, r.asset.model_name]
        .filter(Boolean).join(' '),
```

Append the helpers:

```ts
export interface DeviceListRow {
  id: string; name: string; makeModel: string; ruText: string;
  categoryColor: string | null; group: 'FRONT' | 'REAR';
}

/** Rack-order device list rows: each elevation's REAL blocks sorted top
 *  of rack first (descending top RU, ties by name), FRONT group before
 *  REAR. RU text is a dot-range ("40..42") for multi-U devices. */
export function deviceListRows(
  front: RackBlock[], rear: RackBlock[],
): DeviceListRow[] {
  const toRows = (blocks: RackBlock[], group: 'FRONT' | 'REAR') =>
    [...blocks]
      .sort((a, b) => (b.ru + b.height) - (a.ru + a.height)
        || a.label.localeCompare(b.label))
      .map((b) => ({
        id: b.id, name: b.label,
        makeModel: b.makeModel || '—',
        ruText: b.height > 1 ? `${b.ru}..${b.ru + b.height - 1}` : String(b.ru),
        categoryColor: b.categoryColor, group,
      }));
  return [...toRows(front, 'FRONT'), ...toRows(rear, 'REAR')];
}

export interface LegendCategory { label: string; color: string; }

export const UNCATEGORIZED_FILL = '#eef0f3';

/** Distinct categories present among REAL blocks, sorted by label, with a
 *  trailing "Uncategorized" neutral swatch only when some block lacks a
 *  category. */
export function legendCategories(blocks: RackBlock[]): LegendCategory[] {
  const byLabel = new Map<string, string>();
  let uncategorized = false;
  for (const b of blocks) {
    if (b.categoryLabel && b.categoryColor) byLabel.set(b.categoryLabel, b.categoryColor);
    else uncategorized = true;
  }
  const out = [...byLabel].map(([label, color]) => ({ label, color }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (uncategorized) out.push({ label: 'Uncategorized', color: UNCATEGORIZED_FILL });
  return out;
}
```

- [ ] **Step 4: Run** — `npx vitest run src/lib/initiatives.test.ts src/components/initiatives/RackViewModal.render.test.tsx src/components/initiatives/RackViewModal.test.tsx` — all pass (render test compiles with the new factory fields).

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/initiatives.ts portal/src/lib/initiatives.test.ts portal/src/components/initiatives/RackViewModal.render.test.tsx
git commit -m "feat(portal): rack blocks carry category + device-list/legend helpers"
```

---

### Task 4: Faceplate restyle — category fill, contrast label, verified border, no vents/LED

**Files:**
- Modify: `portal/src/components/initiatives/RackViewModal.tsx` (faceplate render block, ~lines 309–331; tooltip rows fn ~198–214 and call ~385)
- Modify: `portal/src/styles/initiatives.css` (~lines 480–498)
- Test: `portal/src/components/initiatives/RackViewModal.render.test.tsx`

**Interfaces:**
- Consumes: `readableTextColor` (Task 2), `RackBlock.categoryColor/categoryLabel` (Task 3), `UNCATEGORIZED_FILL` (Task 3).
- Produces: faceplate rect carries inline `fill`, `stroke`, `stroke-width` (+ `stroke-dasharray` when planned); label `<text>` carries inline `fill`. Task 6 serializes these inline attributes.

- [ ] **Step 1: Write the failing render tests** — in `RackViewModal.render.test.tsx` add (adapting to the file's existing render/query helpers; faceplates are `rect.rack-faceplate`):

```ts
it('fills faceplates with the category color and contrast label', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}} rows={[
    makeRow({ source_position: null, asset: makeAsset({
      model_category: 'server', model_category_label: 'Server',
      model_category_color: '#1668a7' }) }),
  ]} />);
  const plate = document.querySelector('rect.rack-faceplate')!;
  expect(plate.getAttribute('fill')).toBe('#1668a7');
  const label = document.querySelector('text.rack-block-label')!;
  expect(label.getAttribute('fill')).toBe('#ffffff'); // dark blue → white text
});

it('uses neutral fill + dark text when uncategorized', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}}
         rows={[makeRow({ source_position: null })]} />);
  const plate = document.querySelector('rect.rack-faceplate')!;
  expect(plate.getAttribute('fill')).toBe('#eef0f3');
  expect(document.querySelector('text.rack-block-label')!.getAttribute('fill'))
    .toBe('#111827');
});

it('borders: verified solid green, planned dashed dark; no vents or LED', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}} rows={[
    makeRow({ id: 'v', source_ru: 10, source_verified: true, source_position: null }),
    makeRow({ id: 'p', source_ru: 20, source_verified: false, source_position: null,
              asset: makeAsset({ id: 'a2', serial_number: 'SN-2', name: 'dev-2' }) }),
  ]} />);
  const plates = [...document.querySelectorAll('rect.rack-faceplate')];
  const verified = plates.find((p) => p.getAttribute('stroke') === '#15803d')!;
  expect(verified.getAttribute('stroke-width')).toBe('2');
  expect(verified.hasAttribute('stroke-dasharray')).toBe(false);
  const planned = plates.find((p) => p.getAttribute('stroke') === '#111827')!;
  expect(planned.getAttribute('stroke-dasharray')).toBe('4 3');
  expect(document.querySelector('.rack-faceplate-vent')).toBeNull();
  expect(document.querySelector('.rack-led-verified')).toBeNull();
  expect(document.querySelector('.rack-led-unverified')).toBeNull();
});

it('tooltip shows a Category row when the model has one', () => {
  // hover the faceplate (fireEvent.mouseEnter on its <g> parent) with a
  // categorized asset; assert screen.getByText('Category') and the label.
});
```

(Fill in the tooltip test following the file's existing hover-test pattern.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/initiatives/RackViewModal.render.test.tsx`.

- [ ] **Step 3: Implement**

`RackViewModal.tsx`:
- `import { readableTextColor } from '../../lib/color';` and add `UNCATEGORIZED_FILL` to the `../../lib/initiatives` import.
- Replace the non-ghost faceplate JSX (delete `showVents`, the vent `.map`, the LED `circle`, `ledCx/ledCy`):

```tsx
          const label = rackLabel(b.label, b.position, width);
          const fill = b.categoryColor ?? UNCATEGORIZED_FILL;
          const border = b.verified
            ? { stroke: '#15803d', strokeWidth: 2 }
            : { stroke: '#111827', strokeWidth: 1.25, strokeDasharray: '4 3' };
          return (
            <g key={b.id} onMouseEnter={(e) => onHoverBlock(b, e)} onMouseLeave={onLeaveBlock}>
              <rect x={x} y={y} width={width} height={height} rx={2}
                    fill={fill} {...border} className="rack-faceplate" />
              <text x={x + 8} y={y + height / 2} dominantBaseline="middle"
                    fill={readableTextColor(fill)} className="rack-block-label">
                {label}
              </text>
            </g>
          );
```

- `tooltipRows` gains `categoryLabel: string | null | undefined` in its input and appends `{ label: 'Category', value: categoryLabel }` (before Position) only when truthy; the call site passes `categoryLabel: hover.block.categoryLabel`. Update its doc comment and the pure-helper tests in `RackViewModal.test.tsx` accordingly (one new case: row present with a label, absent without).

`initiatives.css` — delete `.rack-faceplate-verified`, `.rack-faceplate-unverified`, `.rack-faceplate-vent`, `.rack-led-verified`, `.rack-led-unverified`, `.rack-block-label-unverified`; replace with:

```css
/* fill / stroke / label color are INLINE on the SVG (category colors are
   data-driven and the print window serializes the live DOM without app
   CSS) — classes here carry only shared font/shape styling. */
.rack-block-label { font-family: var(--font-mono); font-size: 8.5px; }
```

(Keep `.rack-faceplate-ghost` untouched. Update the header doc comment of `RackViewModal.tsx` — the "grayscale-safe" paragraph now reads: category-color fills with contrast-picked labels; verified solid green vs planned dashed keeps the distinction in grayscale.)

- [ ] **Step 4: Run** — `npx vitest run src/components/initiatives/RackViewModal.render.test.tsx src/components/initiatives/RackViewModal.test.tsx` — all pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/initiatives/RackViewModal.tsx portal/src/components/initiatives/RackViewModal.render.test.tsx portal/src/components/initiatives/RackViewModal.test.tsx portal/src/styles/initiatives.css
git commit -m "feat(portal): rack faceplates — category fill, contrast labels, green verified border"
```

---

### Task 5: Device list panel + dynamic legend in the modal

**Files:**
- Create: `portal/src/components/initiatives/RackDeviceList.tsx`
- Modify: `portal/src/components/initiatives/RackViewModal.tsx` (body layout ~407–433, footer legend ~435–445)
- Modify: `portal/src/styles/initiatives.css` (legend block ~410–428; add list styles)
- Test: `portal/src/components/initiatives/RackViewModal.render.test.tsx`

**Interfaces:**
- Consumes: `deviceListRows`, `legendCategories`, `DeviceListRow`, `UNCATEGORIZED_FILL` (Task 3).
- Produces: `RackDeviceList({ rows, grouped }: { rows: DeviceListRow[]; grouped: boolean })` — Task 6 reuses `deviceListRows` output for the print table (not this component).

- [ ] **Step 1: Write the failing render tests:**

```ts
it('lists devices top-down beside the elevations', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}} rows={[
    makeRow({ id: 'low', source_ru: 5, source_position: null }),
    makeRow({ id: 'high', source_ru: 40, source_position: null,
              asset: makeAsset({ id: 'a2', serial_number: 'SN-9', name: 'top-dev',
                model_make: 'Dell', model_name: 'R740', ru_size: 2 }) }),
  ]} />);
  const cells = [...document.querySelectorAll('.rack-list-name')].map((n) => n.textContent);
  expect(cells).toEqual(['top-dev', 'w1-hs4-m0407']);
  expect(document.querySelector('.rack-list-ru')!.textContent).toBe('40..41');
  expect(screen.getByText('Dell R740')).toBeTruthy();
  // no rear devices → no group subheads
  expect(document.querySelector('.rack-list-group')).toBeNull();
});

it('groups the list under FRONT/REAR when a rear elevation renders', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}} rows={[
    makeRow({ id: 'f', source_ru: 5, source_position: null }),
    makeRow({ id: 'r', source_ru: 40, source_position: 'rear',
              asset: makeAsset({ id: 'a2', serial_number: 'SN-9', name: 'rear-dev' }) }),
  ]} />);
  const heads = [...document.querySelectorAll('.rack-list-group')].map((n) => n.textContent);
  expect(heads).toEqual(['FRONT', 'REAR']);
});

it('legend shows categories present plus the border key', () => {
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}} rows={[
    makeRow({ source_position: null, asset: makeAsset({
      model_category: 'server', model_category_label: 'Server',
      model_category_color: '#1668a7' }) }),
  ]} />);
  expect(screen.getByText('Server')).toBeTruthy();
  expect(screen.getByText('Verified')).toBeTruthy();
  expect(screen.getByText('Planned')).toBeTruthy();
  expect(screen.queryByText('Uncategorized')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`RackDeviceList.tsx`:

```tsx
/**
 * RackDeviceList — the "manifest" panel beside the rack elevations: one
 * row per real device, ordered exactly as the rack reads (top of rack
 * first), grouped under FRONT/REAR subheads only when a rear elevation is
 * shown. Pure presentation over lib/initiatives' deviceListRows.
 */
import type { DeviceListRow } from '../../lib/initiatives';
import { UNCATEGORIZED_FILL } from '../../lib/initiatives';

export default function RackDeviceList({ rows, grouped }: {
  rows: DeviceListRow[]; grouped: boolean;
}) {
  let lastGroup: string | null = null;
  return (
    <div className="rack-device-list">
      {rows.map((r) => {
        const head = grouped && r.group !== lastGroup ? r.group : null;
        lastGroup = r.group;
        return (
          <div key={r.id}>
            {head && <div className="rack-list-group">{head}</div>}
            <div className="rack-list-row">
              <span className="rack-list-swatch"
                    style={{ background: r.categoryColor ?? UNCATEGORIZED_FILL }} />
              <span className="rack-list-name">{r.name}</span>
              <span className="rack-list-model">{r.makeModel}</span>
              <span className="rack-list-ru">{r.ruText}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

`RackViewModal.tsx` — compute once in the component body:

```tsx
  const listRows = deviceListRows(frontBlocks, rearBlocks);
  const categories = legendCategories(blocks);
```

Render `<RackDeviceList rows={listRows} grouped={showRear} />` as the last child inside `.rack-elevations` (after the REAR elevation / before the tooltip node). Replace the footer legend contents with:

```tsx
          <div className="rack-legend" aria-hidden="true">
            {categories.map((c) => (
              <span key={c.label} className="rack-legend-item">
                <span className="rack-legend-swatch" style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
            <span className="rack-legend-item">
              <span className="rack-legend-swatch rack-legend-swatch-verified" />
              Verified
            </span>
            <span className="rack-legend-item">
              <span className="rack-legend-swatch rack-legend-swatch-planned" />
              Planned
            </span>
          </div>
```

`initiatives.css` — update the two named swatches to be border-keys (`.rack-legend-swatch-verified { background: #fff; border: 2px solid #15803d; }`, `.rack-legend-swatch-planned { background: #fff; border: 1.5px dashed #111827; }`) and add:

```css
/* device manifest beside the elevations — mono, tight, reads top-down
   like the rack itself */
.rack-device-list {
  min-width: 240px; max-width: 340px; flex: 1;
  font-family: var(--font-mono); font-size: 12px;
  align-self: flex-start; position: sticky; top: 0;
}
.rack-list-group {
  font-size: 10.5px; letter-spacing: 0.08em; color: #6b7280;
  margin: 10px 0 4px; font-weight: 600;
}
.rack-list-row {
  display: grid; grid-template-columns: 12px 1fr auto auto;
  gap: 8px; align-items: center; padding: 3px 0;
  border-bottom: 1px solid #eceff3;
}
.rack-list-swatch {
  width: 10px; height: 10px; border-radius: 2px;
  border: 1px solid rgba(17, 24, 39, 0.25);
}
.rack-list-model { color: #6b7280; }
.rack-list-ru { text-align: right; min-width: 44px; }
```

(If `.rack-elevations` lacks room, widen `.rack-modal-card`'s max-width enough for elevations + 240px list; keep the flex row.)

- [ ] **Step 4: Run** — `npx vitest run src/components/initiatives/RackViewModal.render.test.tsx` — all pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/initiatives/RackDeviceList.tsx portal/src/components/initiatives/RackViewModal.tsx portal/src/styles/initiatives.css portal/src/components/initiatives/RackViewModal.render.test.tsx
git commit -m "feat(portal): rack modal device list + category legend"
```

---

### Task 6: Print layout window

**Files:**
- Create: `portal/src/lib/rackPrint.ts`
- Modify: `portal/src/components/initiatives/RackViewModal.tsx` (footer, ~435)
- Test: `portal/src/lib/rackPrint.test.ts`, `portal/src/components/initiatives/RackViewModal.render.test.tsx`

**Interfaces:**
- Consumes: `DeviceListRow`, `LegendCategory` (Task 3); inline-styled SVGs (Task 4).
- Produces:

```ts
export function buildRackPrintHtml(input: {
  rackName: string; sideLabel: string; svgs: string[];
  listRows: DeviceListRow[]; grouped: boolean; legend: LegendCategory[];
}): string
```

- [ ] **Step 1: Write the failing unit test** — `portal/src/lib/rackPrint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildRackPrintHtml } from './rackPrint';

const row = { id: 'a', name: 'top-dev', makeModel: 'Dell R740', ruText: '40..41',
  categoryColor: '#1668a7', group: 'FRONT' as const };

describe('buildRackPrintHtml', () => {
  it('embeds heading, svgs, list rows, legend, page sizing, and auto-print', () => {
    const html = buildRackPrintHtml({
      rackName: 'R12', sideLabel: 'Destination',
      svgs: ['<svg data-x="1"></svg>', '<svg data-x="2"></svg>'],
      listRows: [row], grouped: false,
      legend: [{ label: 'Server', color: '#1668a7' }],
    });
    expect(html).toContain('Rack R12 — Destination');
    expect(html).toContain('data-x="1"');
    expect(html).toContain('data-x="2"');
    expect(html).toContain('top-dev');
    expect(html).toContain('Dell R740');
    expect(html).toContain('40..41');
    expect(html).toContain('Server');
    expect(html).toContain('@page { margin: 0.5in; }');
    expect(html).toContain('window.print()');
  });
  it('escapes HTML in names', () => {
    const html = buildRackPrintHtml({
      rackName: '<img>', sideLabel: 'Source', svgs: [], grouped: false,
      listRows: [{ ...row, name: 'a<b>&c' }], legend: [],
    });
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;img&gt;');
    expect(html).toContain('a&lt;b&gt;&amp;c');
  });
  it('renders FRONT/REAR subheads when grouped', () => {
    const html = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source', svgs: [],
      listRows: [row, { ...row, id: 'r', group: 'REAR' as const }],
      grouped: true, legend: [],
    });
    expect(html).toContain('>FRONT<');
    expect(html).toContain('>REAR<');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/rackPrint.test.ts`.

- [ ] **Step 3: Implement** — `portal/src/lib/rackPrint.ts`:

```ts
/**
 * Print-sheet HTML for the rack view: heading, the live-DOM-serialized
 * elevation SVGs (fills/strokes/label colors are inline attributes — see
 * RackViewModal — so only structural line-work needs the small stylesheet
 * here), the device manifest, and the legend. Sized to the INTERSECTION
 * of Letter and A4 printable areas (7.2in × 10in content box, 0.5in
 * margins) so one sheet prints on either paper without clipping.
 * Escaped with a plain text-escaper — every dynamic string passes through
 * esc() — since this document is written into a user-opened window.
 */
import type { DeviceListRow, LegendCategory } from './initiatives';
import { UNCATEGORIZED_FILL } from './initiatives';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const SHEET_CSS = `
  @page { margin: 0.5in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace;
         color: #111827; background: #fff; width: 7.2in; }
  h1 { font-size: 14pt; margin: 0 0 0.15in; font-weight: 600; }
  .sheet { display: flex; gap: 0.25in; align-items: flex-start; }
  .elevations { display: flex; gap: 0.2in; height: 9.2in; flex: none; }
  .elevations svg { height: 100%; width: auto; }
  .list { flex: 1; font-size: 8pt; min-width: 0; }
  .group { font-size: 7pt; letter-spacing: 0.08em; color: #6b7280;
           margin: 0.08in 0 0.03in; font-weight: 600; }
  .row { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 6px;
         align-items: center; padding: 2px 0; border-bottom: 1px solid #d7dce2; }
  .swatch { width: 8px; height: 8px; border-radius: 2px;
            border: 1px solid rgba(17,24,39,0.35); }
  .model { color: #374151; }
  .ru { text-align: right; min-width: 0.4in; }
  .legend { display: flex; gap: 0.2in; margin-top: 0.12in; font-size: 8pt;
            align-items: center; flex-wrap: wrap; }
  .legend .swatch { display: inline-block; vertical-align: -1px; margin-right: 4px; }
  .key-verified { background: #fff; border: 2px solid #15803d; }
  .key-planned { background: #fff; border: 1.5px dashed #111827; }
  /* structural rack line-work (classes come through with the serialized SVG) */
  .rack-post { fill: #f4f6f8; stroke: #111827; stroke-width: 1.5; }
  .rack-cap { fill: #e5e8ec; stroke: #111827; stroke-width: 1.5; }
  .rack-interior { fill: #fff; stroke: #111827; stroke-width: 1; }
  .rack-u-hairline { stroke: #e5e7eb; stroke-width: 0.5; }
  .rack-u-label { font-size: 7px; fill: #6b7280;
                  font-family: ui-monospace, Menlo, monospace; }
  .rack-block-label { font-size: 8.5px;
                      font-family: ui-monospace, Menlo, monospace; }
  .rack-faceplate-ghost { fill: #fff; stroke: #c9ced6; stroke-width: 1; }
  .rack-empty-label { font-size: 10px; fill: #6b7280; }
`;

export function buildRackPrintHtml(input: {
  rackName: string; sideLabel: string; svgs: string[];
  listRows: DeviceListRow[]; grouped: boolean; legend: LegendCategory[];
}): string {
  let lastGroup: string | null = null;
  const listHtml = input.listRows.map((r) => {
    const head = input.grouped && r.group !== lastGroup
      ? `<div class="group">${r.group}</div>` : '';
    lastGroup = r.group;
    return `${head}<div class="row">`
      + `<span class="swatch" style="background:${esc(r.categoryColor ?? UNCATEGORIZED_FILL)}"></span>`
      + `<span>${esc(r.name)}</span>`
      + `<span class="model">${esc(r.makeModel)}</span>`
      + `<span class="ru">${esc(r.ruText)}</span></div>`;
  }).join('');
  const legendHtml = [
    ...input.legend.map((c) =>
      `<span><span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.label)}</span>`),
    '<span><span class="swatch key-verified"></span>Verified</span>',
    '<span><span class="swatch key-planned"></span>Planned</span>',
  ].join('');
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>Rack ${esc(input.rackName)} — ${esc(input.sideLabel)}</title>`
    + `<style>${SHEET_CSS}</style></head><body>`
    + `<h1>Rack ${esc(input.rackName)} — ${esc(input.sideLabel)}</h1>`
    + `<div class="sheet"><div class="elevations">${input.svgs.join('')}</div>`
    + `<div class="list">${listHtml}</div></div>`
    + `<div class="legend">${legendHtml}</div>`
    + `<script>window.onload = () => window.print();</script>`
    + `</body></html>`;
}
```

Note: `input.svgs` is trusted markup serialized from our own rendered DOM, not user text — everything else is escaped.

`RackViewModal.tsx` — footer gains the button after the legend (needs `elevationsRef` — reuse `containerRef`, which already wraps `.rack-elevations`):

```tsx
  const handlePrint = () => {
    const svgs = [...(containerRef.current?.querySelectorAll('.rack-svg') ?? [])]
      .map((el) => el.outerHTML);
    const win = window.open('', '_blank');
    if (!win) return; // popup blocked — quiet no-op
    win.document.write(buildRackPrintHtml({
      rackName, sideLabel, svgs, listRows, grouped: showRear,
      legend: categories,
    }));
    win.document.close();
  };
```

```tsx
          <button className="mini-btn" type="button" onClick={handlePrint}>
            Print layout
          </button>
```

(Modal footer becomes `display: flex; justify-content: space-between; align-items: center` if it isn't already — check `.rack-modal-foot`.)

Render test addition — assert the button exists and `window.open` receives the sheet:

```ts
it('Print layout opens a window and writes the sheet', () => {
  const write = vi.fn();
  const win = { document: { write, close: vi.fn() } };
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
  render(<RackViewModal rackName="R1" side="source" onClose={() => {}}
         rows={[makeRow({ source_position: null })]} />);
  fireEvent.click(screen.getByText('Print layout'));
  expect(openSpy).toHaveBeenCalledWith('', '_blank');
  expect(write.mock.calls[0][0]).toContain('Rack R1 — Source');
  expect(write.mock.calls[0][0]).toContain('<svg');
  openSpy.mockRestore();
});
```

(Import `vi` in the test file if not already imported.)

- [ ] **Step 4: Run** — `npx vitest run src/lib/rackPrint.test.ts src/components/initiatives/RackViewModal.render.test.tsx` — all pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/rackPrint.ts portal/src/lib/rackPrint.test.ts portal/src/components/initiatives/RackViewModal.tsx portal/src/components/initiatives/RackViewModal.render.test.tsx portal/src/styles/initiatives.css
git commit -m "feat(portal): rack print layout window sized for Letter/A4"
```

---

### Task 7: Verification (controller-led)

**Files:** none created — full-suite runs + live browser check.

- [ ] Run the FULL API suite foreground: from `api/`, `.venv/bin/python -m pytest -q` (timeout 600000) — all pass.
- [ ] Run the FULL portal suite + build foreground: from `portal/`, `npx vitest run && npm run build` (timeout 600000) — all pass, build clean.
- [ ] Live check in the browser pane (dev login, seeded initiative with racked assets): open the rack popup — category fills with readable labels, verified solid green vs planned dashed, no vents/LED, device list top-down beside the elevations, dynamic legend; click Print layout — new tab shows the sheet (heading, elevations, list, legend) and triggers the print dialog. Assign a category color to at least one seeded model first if none have one.
- [ ] Fix anything found (source edits, re-run affected tests), commit fixes.
