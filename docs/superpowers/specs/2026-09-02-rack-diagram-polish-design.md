# Rack diagram polish — category colors, verified border, device list, print layout

**Date:** 2026-09-02
**Branch:** working branch off `main`
**Status:** Approved design (user pre-approved implementation)

## Purpose

Polish the rack elevation popup (`RackViewModal`, opened from the
Initiatives full-detail Assets table): drop the decorative vent lines
("underline" under the name) and the status LED circle; fill each device
with its asset-model **category color** with contrast-aware label text;
mark a verified location with a **solid green border** (planned stays
dashed dark); add a **device list** to the right of the elevations (in the
modal AND on paper); and add a **Print layout** button that opens a
print-ready sheet sized to fit both Letter and A4.

## Background facts (as-built)

- `portal/src/components/initiatives/RackViewModal.tsx` renders FRONT
  (+REAR when a real rear-mounted device exists) elevations from
  `rackLayout(rows, rackName, side)` in `portal/src/lib/initiatives.ts`.
  Blocks: `{ id, label, ru, height, position, verified }`; ghost boxes
  mirror opposite-side devices (`isGhost`), no label/LED.
- Faceplate styling lives in `portal/src/styles/initiatives.css`
  (`.rack-faceplate-verified` solid + gray fill,
  `.rack-faceplate-unverified` dashed, `.rack-faceplate-vent`,
  `.rack-led-*`, `.rack-block-label*`).
- Asset models have `category` → `asset_categories(key, label, color,
  sort_order)`; category colors are user-managed (Variables dev screen).
- `InitiativeAssetSummary` (api/schemas.py, populated in
  `_initiative_asset_rows` in `api/src/serversherpa/api/routes/initiatives.py`)
  carries `model_make`/`model_name`/`ru_size` but NOT the category.
- No portal contrast helper exists yet; `window.open` is already used
  elsewhere (notifications pages).

## API changes

`InitiativeAssetSummary` gains three additive optional fields, populated
in `_initiative_asset_rows` by joining the model's category row:

```python
model_category: str | None = None          # category key
model_category_label: str | None = None    # AssetCategory.label
model_category_color: str | None = None    # AssetCategory.color (hex)
```

All null when the asset has no model or the model has no category. No
migration; no other endpoints change.

## Portal changes

### Contrast helper (`portal/src/lib/color.ts`, new)

```ts
/** '#111827' on light fills, '#ffffff' on dark — WCAG relative luminance. */
export function readableTextColor(hex: string): '#111827' | '#ffffff'
```

Parses `#rgb`/`#rrggbb` (case-insensitive); malformed input returns
`'#111827'`. Threshold: luminance > 0.45 → dark text.

### `rackLayout` blocks (`portal/src/lib/initiatives.ts`)

`RackBlock` gains `categoryLabel: string | null` and
`categoryColor: string | null` (from the row's asset summary), plus
`makeModel: string` (joined `model_make model_name`, '' when absent) so
the device list and print sheet don't re-derive it.

### Faceplate restyle (`RackViewModal.tsx` + `initiatives.css`)

- Remove the vent `<line>`s and the LED `<circle>` (and their CSS).
- Fill: inline `fill={categoryColor ?? '#eef0f3'}` on the faceplate rect
  (inline so the serialized print SVG needs no stylesheet).
- Label: inline `fill={readableTextColor(fill)}`; drop
  `.rack-block-label-unverified`'s muted color (contrast now rules).
- Border: planned keeps `stroke: #111827; stroke-dasharray: 4 3`;
  verified becomes **solid `#15803d`, stroke-width 2**. Applied as inline
  stroke props (print-portable), classes retained only for shared font
  styling. Solid-vs-dashed keeps the distinction in grayscale.
- Ghost boxes unchanged.
- Tooltip gains a `Category` row (label; omitted when null).

### Device list (modal + print)

New presentational component `RackDeviceList` (same file or
`components/initiatives/RackDeviceList.tsx`): rendered to the RIGHT of
the elevations inside `.rack-elevations`' flex row.

- One row per REAL device (ghosts excluded), sorted **top of rack first**:
  descending by top RU (`ru + height - 1`), ties by name.
- Columns: category swatch (10px square, category color, neutral when
  none), Name, Model (`makeModel` or '—'), RU (`40..42` range for
  multi-U, single number for 1U).
- When REAR renders, the list groups under FRONT / REAR subheadings
  (each group top-down); otherwise no subheading.
- Pure ordering/formatting helpers (`deviceListRows(blocks)` returning
  `{ id, name, makeModel, ruText, categoryColor, group }[]`) exported
  from `lib/initiatives.ts` for unit tests.

### Legend

Footer legend becomes: one swatch+label per category present among real
blocks (sorted by label; uncategorized shown as "Uncategorized" with the
neutral swatch only when present), followed by the border key — solid
green swatch = Verified, dashed swatch = Planned.

### Print layout

`Print layout` button in the modal footer (next to the legend):

1. Serializes the rendered elevation SVG(s) from the live DOM
   (`outerHTML`; fills/strokes/labels are inline, structural line-work
   colors get a tiny embedded stylesheet).
2. Opens `window.open('', '_blank')`; if blocked (null), shows the
   modal's quiet no-op (button flashes disabled) — no crash.
3. Writes a standalone document: heading `Rack {name} — {side}`, the
   elevations, the device list (plain HTML table), the legend, plus
   embedded print CSS and `<script>window.onload = () => window.print()</script>`.
4. Sizing: content box **7.2 in × 10 in** (fits Letter and A4 with
   0.5 in margins; `@page { margin: 0.5in }`). Elevations get
   `height: 10in; width: auto` (7in with both FRONT+REAR + gap; list
   takes the remaining width). White background, black text.

## Error handling

- Missing category / model → neutral fill `#eef0f3`, dark text, '—'
  model cell, no category tooltip row.
- Malformed category color hex → `readableTextColor` falls back to dark
  text; the fill is applied as-is (browser ignores invalid fills →
  effectively neutral).
- Popup blocked → no window, no error thrown.

## Testing

- Unit: `readableTextColor` (light/dark/3-digit/malformed),
  `deviceListRows` (ordering incl. multi-U ties, grouping, RU range
  text), legend category derivation.
- Render (`RackViewModal.render.test.tsx`): no vents/LED; inline
  category fill + contrast label color; verified = solid green stroke,
  planned = dashed; list rows present in top-down order; legend
  swatches; Category tooltip row.
- API (`test_initiatives_*`): rows expose
  `model_category`/`label`/`color`; nulls without category.
- Live: browser-pane check on seeded data (colors, contrast, verified
  border, list, print window content).

## Out of scope

TV/status-board view; editing from the diagram; per-device print
selection; PDF generation (browser print dialog only).
