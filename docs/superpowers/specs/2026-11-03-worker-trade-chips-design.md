# Worker trades as chips — design

Date: 2026-11-03. Branch `trade-chips`. Portal only.

## Problem

A worker's trade is one text field (`worker_profiles.trade`) that people fill
with a comma-separated list, e.g. `Cable, General, Hardware`. The portal shows
it as that raw string everywhere, and the Workers list's Trade filter offers
each full combination as one checkbox, so you can't filter to everyone who
does Hardware.

## Decisions (Jimmy, 2026-11-03)

- Show trades as chips wherever a worker's trade is shown.
- Editing uses chips too (the same chips input External contacts use for
  Functions).
- The Trade column filter lists each trade on its own.

## Data

No API or database change. The field stays one text value. The portal splits
it on commas, trims each part and drops empty parts. On save the chips are
joined back with `", "`. Kiosk apps, bulk import and CSV export keep reading
and writing the same text.

## Shared pieces

- `splitTrades(trade: string | null): string[]` in `portal/src/lib/workers.ts`
  — split on `,`, trim, drop empties, drop case-insensitive duplicates
  (first spelling wins), keep order.
- `TradeChips` component (`portal/src/components/workers/TradeChips.tsx`) —
  renders `<div className="chips">` with one `chip tag` per trade (the same
  neutral chip External's Functions column uses). With no trades it renders
  the caller's fallback text (default `—`).

## Where chips appear

| Place | Today | After |
|---|---|---|
| Workers list, Trade column | text, one line | chips |
| Workers list, detail panel `Trade` | text | chips |
| Worker page header line | `trade · partner` | trade chips, then `· partner`; `No trade set` when empty |
| Worker page Profile panel `Trade` | text | chips |
| Partner page (StakeholderDetail) Workers tab, Trade column | text | chips |
| User page › Profile › Worker profile table, Trade cell | text | chips |
| Org Directory worker picker sub-line | `trade · level` | trade chips then level; `no profile` when both empty |

Chips wrap inside their cell. List rows keep the existing cell layout; a cell
with many trades grows taller rather than clipping.

## Editing

`ProfileForm` (Edit profile on the Workers detail panel and the Worker page)
replaces the Trade text box with `TagInput` in free-text mode:

- seeded with `splitTrades(worker.trade)`;
- suggestions are the trades already used by other workers, when the caller
  has them (the Workers page passes the distinct trades from its loaded rows;
  the Worker page passes none);
- saves `tags.join(', ')`, or `null` when there are none.

The list's inline god-edit Trade cell stays a plain text box (comma-separated
text), since god-edit has no chips kind.

## Filtering

`lib/columnMenu.tsx` gains an optional multi-value accessor:

```ts
export type CellValues<T> = (row: T, colKey: string) => string[] | null;
```

Passed to `ColumnMenu` (prop `cellValues`) and as an optional last argument to
`passesColumnFilters`, `rowsForMenu` and `uniqueValues`. When it returns an
array for a column (`null` = use the single text as today):

- the checklist lists each value once; a row with no values counts as `—`;
- a `values` selection passes a row when any of its values is selected;
- an `exclude` list passes a row when at least one of its values is not
  excluded (so unchecking Hardware still shows a `Cable, Hardware` worker
  because Cable is still checked);
- a typed text filter still substring-matches the full trade text;
- an older saved selection holding a full combination (e.g.
  `Cable, Hardware`) still matches a row whose full text equals it, so saved
  filters keep working.

Used by the Workers list and the partner page's Workers tab for `trade`.
Sorting, global search and CSV export keep using the full text.

## Testing

- `splitTrades` unit tests (spacing, empties, duplicates, null).
- `columnMenu` tests for the multi-value rules above, including exclude and
  the old combined-value case.
- `TradeChips` render test; Workers, WorkerDetail, StakeholderDetail,
  UserDetail and OrgDirectory tests updated for chips.
- `ProfileForm` test: chips seeded from the text, save sends the joined text
  and `null` when empty.

## Out of scope

Kiosk apps (Android/iOS Rolodex), bulk worker import, CSV export format and
the god-edit cell keep the text form.
