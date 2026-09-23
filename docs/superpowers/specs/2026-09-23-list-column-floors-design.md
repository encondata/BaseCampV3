# List column floors, adaptive headers, and sideways scroll — design

Lists across the portal size their columns dynamically with `fr` grid
tracks. That works on a wide window and breaks on a smaller one: no column
has a floor, so tracks shrink toward zero and any content that cannot wrap
(uppercase mono header labels, chips, mono IDs) paints across its neighbor.
Jimmy asked (2026-09-23) for lists to keep dynamic sizing at the size of a
14-inch M3 MacBook Pro window and larger, and to scroll sideways below that
instead of colliding, with header labels and values that are long when
there is room and shortened when there is not.

This spec covers the **initiative detail page** (`/initiatives/:id`) as the
pilot. The same mechanisms are meant to roll out to every other list once
the pilot is accepted; the rollout is a mechanical follow-up and is listed
at the end, not built here.

## What exists

- `lib/listTools.tsx` — the shared `ColumnDef` (`key`, `label`, `width`,
  `default`, `godOnly?`), `visibleColumnsFor`, the header drag reorder hook,
  and the `ColumnsButton` picker. `width` is a raw grid track string
  (`'1.2fr'`, `'88px'`).
- Pages build the grid inline: `gridTemplateColumns: shownCols.map((c) =>
  c.width).join(' ') + trailing tracks`, applied to both `.list-head` and
  every `.row-main`. On the pilot page: `peopleGrid` (5 people columns +
  an 88px actions track when the viewer can change) and `assetsGrid` (27
  move-asset columns, 9 shown by default, + actions + a 30px chevron).
- `styles/directory.css` — the list primitives. `.dir-list` is the card
  (`overflow: hidden` for its 16px radius); `.list-head` / `.row-main` are
  the grids (`gap: 16px`, `padding: 0 20px` / `var(--list-row-pad-y) 20px`);
  `.cell { min-width: 0 }`; the golden text classes `.cell-top`,
  `.cell-sub`, `.mono`, `.chip` (a chip inside a cell already truncates
  with an ellipsis). `.cell-nowrap` is an opt-in single-line ellipsis
  modifier. One list (`.dir-list.ngd-notif-grid`, Notifications) already
  opts into `overflow-x: auto`. The ≤768px media rule turns rows into
  three-column cards and hides the header; it is unchanged by this spec.
- `lib/columnMenu.tsx` — `ColumnMenu`, the per-column funnel button whose
  `.pop-menu` is `position: absolute` inside the header cell. Because a
  scrolling card clips it, the pilot page's two lists override the card to
  `overflow: visible` (`.idet-people-list`, `.idet-assets-list` in
  `styles/initiatives.css`) and re-round the corners by hand.
- The pilot page's two mini-lists (`init-rows` linked initiatives, a flex
  row; `idet-time-list`, a `minmax()` grid) do not collide today; the
  time list already has floors.
- `styles/listTypography.test.ts` — the guardrail. It forbids typography
  on list selectors outside `directory.css`, raw `<table>`s, inline
  `fontSize`-style props, and page co-class rules that restate the box
  model of a `mini-row`/`mini-list-head`. Inline `minWidth` and
  `gridTemplateColumns` are allowed; new rules in `directory.css` must use
  the `--list-*` tokens for typography.

## Target size

A 14-inch M3 MacBook Pro window is 1512 CSS px wide. With the nav expanded
(`--nav-width: 248px`) and `.portal-page` padding (`clamp(24px, 3.2vw,
44px)` = 44px a side), a full-width list is **about 1176px** wide. On the initiative detail page the lists sit inside an `.init-panel` with 18px of padding a side, so they get **1136px**; that is the pilot's fit target. That is
the width at which every list's default column set must fit with no
sideways scroll. Wider windows keep today's fluid behavior; narrower ones
scroll.

## Mechanisms

### 1. Column floors (`min`) and the grid helper

`ColumnDef` gains two optional fields:

```ts
min?: number;    // px floor for the track; derived from the label when absent
short?: string;  // header label used when the long label would overflow
```

A new pure helper in `lib/listTools.tsx`:

```ts
export function listGridStyle(
  cols: ColumnDef[],
  trailing: string[] = [],       // fixed trailing tracks, e.g. ['88px', '30px']
  gap = 12,                      // px between tracks (the list-scroll gap)
): { gridTemplateColumns: string; minWidth: number }
```

- Each column becomes `minmax(<min>px, <width>)` when `width` is an `fr`
  value, and stays as written when it is already a fixed length.
- `min` defaults to a floor derived from the label that sizes the column:
  the short label when present, else the long one. The derivation is
  `max(72, ceil(labelChars * 7.4) + 30)` — 7.4px per character is a 10px
  mono glyph plus 0.14em tracking; 30px covers the sort caret and the
  funnel button. An explicit `min` must be at least the derived floor of
  its short label, otherwise the short label could itself overflow; the
  helper takes the larger of the two so a too-small explicit value cannot
  break the guarantee. The constants live next to the helper with that
  explanation. Floors assume list scale 1 (the `list_size` preference);
  a larger scale simply reaches the short label and the scrollbar sooner.
- `minWidth` is the sum of the floors, the fixed trailing tracks, the
  gaps between tracks, and the 40px of horizontal padding. Both
  `.list-head` and every `.row-main` receive it inline alongside
  `gridTemplateColumns`, so a row's hover background paints across the
  full scrolled width, not just the visible part. The helper takes the gap
  as a parameter (default 12, the `list-scroll` gap below).
- Numbers are px; the helper renders the CSS strings.
- On the initiative detail page the row minimum is at most 1136px (the panel's
  18px padding comes off the 1176px page width).

Floors for the pilot page's nine default asset columns, chosen so that with
the 88px actions track, the 30px chevron track, ten 12px gaps, and 40px of
padding the row minimum is at most 1136px:

| column | short label | min | derived floor |
| --- | --- | --- | --- |
| Asset ID | — | 90 | 89 |
| Asset Name | — | 120 | 104 |
| Serial | — | 100 | 74 |
| Make/Model | — | 104 | 104 |
| Status | — | 90 | 74 |
| Source Rack | Src Rack | 92 | 89 |
| Source RU | Src RU | 76 | 74 |
| Destination Rack | Dest Rack | 100 | 97 |
| Destination RU | Dest RU | 84 | 82 |

Columns sum to 856; the row minimum is 856 + 88 + 30 + 120 + 40 =
**1134px**, under the 1136px target. Read-only viewers (no actions track)
land at 1034px.

Non-default asset columns get short labels where the long one is wordy
(`Source Verified` → `Src Verified`, `Source Position` → `Src Position`,
`Source Pod` → `Src Pod`, `Destination Verified` → `Dest Verified`,
`Destination Position` → `Dest Position`, `Destination Pod` → `Dest Pod`,
`Vendor Involved` → `Vendor`) and floors from the derivation. People
columns: Name 140, Work type 110 (short `Type`), Site worked 120 (short
`Site`), Rating 76, Added 96.

### 2. Adaptive header labels (`useFitLabel`)

A new hook in `lib/listTools.tsx`:

```ts
export function useFitLabel(long: string, short?: string):
  { ref: RefObject<HTMLElement>; label: string }
```

- The header cell renders the returned `label` inside its sortable button
  and passes `ref` to the cell (`.col-head`).
- The hook measures the long label's natural width once (a hidden
  `nowrap` clone of the button text, or the button's `scrollWidth` while
  the long label is rendered) and observes the cell with a
  `ResizeObserver`. When the cell's content box (minus the funnel button)
  is narrower than the long label needs, `label` is `short`; otherwise
  `long`. Without a `short`, the hook returns `long` and attaches nothing.
- Hysteresis is not needed: the floor guarantees the short label always
  fits, so the swap cannot oscillate.
- In jsdom (`ResizeObserver` undefined) the hook returns `long` and does
  nothing, so existing page tests are unaffected; the hook's own test
  stubs `ResizeObserver` and asserts the swap both ways.

The header markup moves into a small shared `ColHead` component in
`listTools.tsx` (label, caret, `ColumnMenu`, drag props) so the pilot page
and later rollouts do not each re-implement the measuring cell. The pilot
page's two header loops switch to it.

### 3. Value truncation (`.cell-line`)

`directory.css` gains one class next to `.cell-nowrap`:

```css
.cell .cell-line {
  display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
```

It is the same rule as `.cell-nowrap` under a name that says what it is for
(a single-line value). `.cell-nowrap` stays for its existing users; the
plan may alias one to the other rather than duplicate the declaration.

On the pilot page every single-line value in the people and assets lists
carries `cell-line` alongside its golden class (`cell-top cell-line`,
`mono cell-line`) and a `title` attribute with the full text so the
truncated value is readable on hover. Chips already truncate. God-mode
inline editors (`GodCell`) are inputs and are left as they are.

### 4. Sideways scroll (`.dir-list.list-scroll`)

`directory.css`:

```css
.dir-list.list-scroll { overflow-x: auto; overflow-y: hidden; }
.dir-list.list-scroll .list-head,
.dir-list.list-scroll .row-main { gap: 12px; }
```

- The card scrolls as one unit: header and rows share the scroll position
  because they are siblings inside the scrolling card. Row `minWidth`
  keeps hover paint and the header background full-width.
- The scrollbar is the platform's own (thin overlay on macOS). No custom
  scrollbar styling.
- The 16px card radius still clips correctly because the card is the
  scroll container.
- `overflow-y: hidden` is explicit so an open row detail (`.detail` grid
  animation) never produces a vertical scrollbar inside the card.
- The ≤768px card layout is unaffected: rows there are `1fr` columns with
  no `minWidth` (the helper's inline `minWidth` is overridden by
  `min-width: 0 !important` inside that media rule so phones never scroll).

Both pilot dir-lists get `list-scroll`; the two `.idet-*-list { overflow:
visible }` overrides and their corner re-rounding rules are deleted
because mechanism 5 makes them unnecessary.

The two mini-lists: `idet-time-list` gets a `mini-list.list-scroll`
variant (same `overflow-x: auto`) since its `minmax` floors already sum to
450px and only need somewhere to overflow; `init-rows` is a flex row whose
children shrink and wrap the role field, and is left alone.

### 5. Portaled column menu

`ColumnMenu` renders its `.pop-menu` through `createPortal` into
`document.body`, positioned `fixed` from the trigger's `getBoundingClientRect()`
(top = trigger bottom + 8px; right-aligned to the trigger's right edge,
flipped to left-aligned when that would run off the viewport's left).
Position is recomputed on open, on window resize, and on scroll of any
ancestor (a capture-phase `scroll` listener on `window` while open), so the
menu follows its header when the card scrolls sideways or the page
scrolls; the menu closes if the trigger scrolls out of the card's visible
box.

- Outside-click closing already uses a `ref` on `.pop-wrap`; with the
  menu portaled, the handler also treats clicks inside the menu element as
  inside (a second ref).
- `.pop-menu.colmenu-menu.portaled { position: fixed; }` in
  `column-menu.css`; every other `.pop-menu` (topbar popovers, AI menu)
  keeps its absolute positioning and is untouched.
- Existing `ColumnMenu` tests keep passing because RTL queries search
  `document.body`; a new test asserts the menu is not a DOM descendant of
  the header cell and that clicking inside it does not close it.

## Data flow on the pilot page

1. `MOVE_ASSET_COLUMNS` (`lib/initiatives.ts`) and `PEOPLE_COLUMNS`
   (`InitiativeDetail.tsx`) gain `short` and `min` per the tables above.
2. `assetsGrid` / `peopleGrid` become `listGridStyle(shownCols, trailing)`
   where `trailing` is `['88px', '30px']` / `['88px']` when `canChange`,
   `['30px']` / `[]` otherwise. The result spreads into the existing
   `style={…}` on `.list-head` and `.row-main`.
3. Header loops render `<ColHead>`; value cells add `cell-line` + `title`.
4. Both `.dir-list` cards add `list-scroll`; `initiatives.css` loses the
   overflow-visible block.

Nothing on the API changes. No other page changes.

## Error handling

There are no failure modes in the data sense. Defensive behavior:

- `listGridStyle` tolerates a `width` that is neither `fr` nor a length
  (passes it through untouched, floor still added to `minWidth`).
- `useFitLabel` guards `ResizeObserver` and `getBoundingClientRect` being
  absent (jsdom) and never throws.
- The portaled menu falls back to its current in-place absolute
  positioning if `document.body` is unavailable (SSR-safe guard; the
  portal is only used in the browser).

## Testing

- `lib/listTools.test.tsx`: `listGridStyle` — `fr` columns wrap in
  `minmax`, fixed widths pass through, explicit `min` beats the derived
  one, the derived floor uses the short label, `minWidth` sums floors +
  trailing + gaps + padding. `useFitLabel` — long by default, short when
  the observed width is below the long label's width, long again when it
  grows, no-op without `short`.
- `lib/columnMenu.test.tsx`: menu opens into `document.body`, not inside
  the header; click inside the menu keeps it open; outside click closes;
  filter still applies.
- `pages/InitiativeDetail.test.tsx`: existing tests pass; one new assertion
  that the assets header and first row carry the same
  `grid-template-columns` and `min-width`, and that the card has
  `list-scroll`.
- `styles/listTypography.test.ts` stays green: the new rules use tokens or
  are layout-only, and `cell-line` is a modifier class, not typography.
- Live verify in the browser (dev stack): at 1512px wide with the nav
  expanded the assets table shows nine columns with no scrollbar and long
  labels; at ~1200px the long labels swap to short and a scrollbar
  appears; the column filter popover opens fully over the scrolled card;
  a long asset name shows an ellipsis with the full name on hover.

## Rollout (not in this spec's plan)

Once the pilot is accepted, each list migrates by: adding `short`/`min`
to its `ColumnDef`s, replacing its inline template with `listGridStyle`,
switching its header loop to `ColHead`, adding `cell-line` to single-line
values, and adding `list-scroll` to its card. The 40 files that build
`width: '…fr'` column sets are the checklist (`grep -rl "width: '[0-9.]*fr'"
portal/src`). Lists that already opt into `overflow-x: auto`
(Notifications) drop their page-specific rule in favor of `list-scroll`.
A guardrail addition — every `.dir-list` header loop uses `ColHead` — is
worth adding at the end of the rollout, not before.
