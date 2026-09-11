# Initiatives › Timeline — calendar and timeline views of initiatives

**Date:** 2026-09-10 · **Status:** approved in conversation ("Initiatives would be
good with a dashboard with calendar/timeline") · **Branch:** `init-timeline`

## Purpose

The Initiatives section has one nav entry. Jimmy wants a second: a dashboard
that shows initiatives on a **timeline** (Gantt-style bars) and on a
**month calendar**, so scheduling conflicts and upcoming work are visible at
a glance. No new data: initiatives already carry `scheduled_start`,
`scheduled_end`, `real_start_at`, `real_end_at`, status, type, client, and
site. American English throughout.

## Page

`/initiatives/timeline`, nav item **Timeline** under Initiatives (resource
`initiatives`), CommandPalette `navGated('Initiative timeline',
'/initiatives/timeline', 'initiatives')`. Page chrome: eyebrow
"Initiatives", title "Timeline", hint "Scheduled and in-flight initiatives
on a timeline or a month calendar." Data from the existing
`listInitiatives()`; archived and `cancelled` initiatives are excluded by
default (a `pill-check` "Show cancelled" adds them back).

### Toolbar (standard idioms)

- `.segmented` view switch: **Timeline** / **Month**.
- `.segmented` type pills: All / Projects / Events / Moves (same keys as
  Initiatives.tsx's `TYPE_PILLS`, with counts).
- Status filter: `ComboBox` multi? No — a `.segmented` of the status
  vocabulary (Planned, Scheduled, In progress, On hold, Completed) with
  "All" first; single-select. Cancelled only via the pill-check.
- Client `ComboBox` (clearable) built from the initiatives' own client ids.
- Range controls: **‹ / Today / ›** mini-btns and a `.segmented` scale
  **Month / Quarter / Year** (Timeline view only); the Month view has its
  own ‹ / Today / › over the month name.
- Everything persists per user via `usePersistentListState('initiatives-timeline', …)`
  where the shape fits (view, scale, type, status); the range anchor date
  is session state only.

### Timeline view

- Left column (fixed 260px): initiative name (`.pn b`) + client/site
  (`.pn span`), clicking opens `/initiatives/{id}`. Rows sorted by
  `scheduled_start` asc, unscheduled last.
- Right pane: horizontal scroll; header row of period ticks (days for
  Month scale, weeks for Quarter, months for Year); vertical "today" line.
- One **bar** per initiative from `scheduled_start` to `scheduled_end`
  (missing end → 1-day bar; missing start → no bar, row listed under a
  "Unscheduled" divider with the text "No dates yet"). Bar color = the
  status color (`--chip` style var), label inside the bar when it's wider
  than 80px, `title` tooltip "name · status · start → end".
- When `real_start_at` exists, a thinner second bar beneath in the same
  color at 60% opacity from `real_start_at` to `real_end_at ?? today`.
- Empty state (no initiatives in range after filters): `dir-empty` "No
  initiatives in this range."
- Pure geometry lives in `lib/timeline.ts`: `rangeFor(anchor, scale)`,
  `ticksFor(range, scale)`, `barFor(item, range)` → `{ left%, width% } | null`,
  `sortForTimeline(items)`; unit-tested, no DOM.

### Month view

- Standard 7-column month grid (Mon–Sun) with leading/trailing days muted;
  today's cell outlined with the accent.
- Each day cell lists the initiatives active that day (start ≤ day ≤ end,
  end defaulting to start) as status-colored `chip custom` entries (name,
  truncated); more than 3 → "+N more" which opens a small popover list.
  Clicking an entry opens `/initiatives/{id}`.
- `lib/timeline.ts`: `monthGrid(anchor)` (42 cells) and
  `itemsOnDay(items, day)`.

### Styling

New `styles/initiative-timeline.css`, **layout only** (grid columns, bar
positioning, cell sizes, sticky left column, today line). Text uses the
golden classes (`.pn b`, `.pn span`, `mono` for dates, chips). No
font-size/family/weight/line-height/min-height on any list-ish selector,
no new `listTypography.allow.json` entries.

## Testing

- `lib/timeline.test.ts`: range/ticks per scale, `barFor` clipping at both
  edges and null for unscheduled, missing-end → 1 day, `monthGrid` shape,
  `itemsOnDay` inclusive bounds, sort order.
- `pages/InitiativeTimeline.test.tsx` (mock `listInitiatives`): renders
  rows + bars for scheduled items, unscheduled section, type/status filters
  narrow rows, cancelled hidden until the pill-check, switching to Month
  shows the grid with the item chips on its days, ‹ › move the range.
- Typography guardrail green; `tsc` clean.
- Live: page loads on the worktree server; both views; nav + palette.

## Out of scope

Drag-to-reschedule, editing from the timeline, week/day views, resource
(people) lanes, iCal export.
