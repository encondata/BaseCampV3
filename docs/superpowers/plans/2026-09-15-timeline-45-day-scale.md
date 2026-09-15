# Timeline: a 45-day scale, and months on the ruler — plan

Jimmy, 2026-09-15, on /initiatives/timeline: "can we show 45 days? we should
also list the month and not just 1-30."

Branch `timeline-scale`, worktree `.claude/worktrees/timeline-scale`, off
`reports` @ 6091e0b. Portal only — no API, no migration.

## Two changes

### 1. A 45-day scale

The scale pills are Month / Quarter / Year. Add **45 days** between Month and
Quarter.

**Range:** the Monday of the anchor's week, plus 45 days (end-exclusive). Monday
alignment matches `monthGrid`'s Monday-first weeks and keeps the current week
whole and visible, rather than starting mid-week or hiding what began a few days
ago. `stepAnchor` moves it ±45 days, which preserves that Monday alignment.
"Today" resets the anchor to today as it already does.

**Ticks:** one per day, same as the Month scale.

**Right-pane width:** `ticks.length * 32`, matching the Month scale's per-day
density (45 × 32 = 1440px, so it scrolls — that is expected and fine, the pane
already scrolls horizontally).

**Range label:** the toolbar currently shows a label only in the calendar view.
The timeline's ‹ Today › nav shows none. Out of scope to add one everywhere, but
the month band below makes the span readable, so no separate label is needed.

### 2. A month band on the ruler

Day numbers alone read as "… 29 30 1 2 3 …" across a month boundary, which is
exactly the complaint. Add a second header row above the day numbers naming each
calendar month the range covers, positioned over that month's own span.

Applies to the scales whose ticks are days or weeks: **month, 45 days, quarter**.
The **year** scale already labels its ticks with month names, so it gets no band
(a band there would just repeat them).

A band segment whose span is too narrow for its label must not overflow into its
neighbor — clip it rather than let it paint over, per the list-overlap lesson
from earlier today.

## Global constraints

- Portal commands from the worktree's `portal/`: `npx vitest run <paths>` then
  `npx tsc -b`. Foreground; never background a suite and end your turn waiting.
- TDD, red first, for every behavior change.
- Never weaken an existing assertion. Never `git add -A`. Never `git stash` (the
  stack is shared with other worktrees). Leave the `portal/node_modules` symlink
  alone.
- The list-typography guardrail (`portal/src/styles/listTypography.test.ts`)
  forbids font-size / font-family / font-weight / line-height / min-height in a
  page stylesheet on a list-ish selector, and inline `fontSize` and friends via
  the `style` prop. `.itl-*` is a list-ish family (`.itl-row` establishes the
  `itl` prefix), so the new band's CSS must be layout, color and size only, and
  its text must take typography from an existing golden class.
- American English. Every commit ends with the trailer line exactly:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Task 1 — `lib/timeline.ts`: the scale and the bands

**Files:** `portal/src/lib/timeline.ts`, `portal/src/lib/timeline.test.ts`.

- [ ] **Step 1: failing tests.**
  - `TimelineScale` accepts `'45d'`.
  - `rangeFor(anchor, '45d')` starts on the Monday of the anchor's week and ends
    exactly 45 days later, end-exclusive. Cover an anchor that IS a Monday, a
    mid-week anchor, and a Sunday anchor (Sunday belongs to the week that began
    the previous Monday — match `monthGrid`'s convention and assert it).
  - `ticksFor(range, '45d')` returns 45 ticks, one per day, labelled with the day
    of the month.
  - New `monthBandsFor(range)`: one entry per calendar month intersecting the
    range, each `{ label, left, width }` as percentages of the range, clipped at
    both ends. A range inside one month yields a single band at 0/100. A 45-day
    range yields two or three. Bands are contiguous and sum to 100.
    Label format: `MMM YYYY` (e.g. `Sep 2026`) so a range crossing a year
    boundary stays unambiguous.
- [ ] **Step 2: implement.** Reuse the existing `dateOnly` / `addDays` /
      `MONTH_ABBR` helpers; do not add a second date-parsing path.
- [ ] **Step 3:** `npx vitest run src/lib/timeline`, `npx tsc -b`; commit
      `feat(timeline): a 45-day scale and month bands for the ruler`.

## Task 2 — The page: the pill, the band, the CSS

**Files:** `portal/src/pages/InitiativeTimeline.tsx`,
`portal/src/styles/initiative-timeline.css`,
`portal/src/pages/InitiativeTimeline.test.tsx`.

- [ ] **Step 1: failing tests.** A "45 days" pill sits between Month and
      Quarter; choosing it renders 45 day-ticks; ‹ and › step the range by 45
      days; the month band renders one segment per month covered, in order, for
      the month / 45-day / quarter scales and not for year; the scale choice
      still persists to localStorage (`isScale` must accept `'45d'` or a
      remembered value is silently dropped back to month — test that round trip).
- [ ] **Step 2: implement.** Add the pill to `SCALES`; widen `isScale`;
      `stepAnchor` moves ±45 days for the new scale; `rightWidth` uses the
      per-day density for it. Render the band as a row inside
      `.itl-header-row` above `.itl-ticks`, each segment absolutely positioned
      from its `left`/`width` percentages, with `overflow: hidden` so a narrow
      month clips instead of spilling. The header's height grows by the band
      row — check `.itl-corner` and the sticky offsets still line up.
- [ ] **Step 3:** `npx vitest run src/pages/InitiativeTimeline src/styles/listTypography`,
      `npx tsc -b`; commit `feat(timeline): 45-day scale pill and a month band above the day ruler`.

## Task 3 — Verify

- [ ] Full portal suite, `npm run build`, `npx tsc -b`.
- [ ] Live: a dev server for this branch (the shared API on 8000 is fine — this
      branch changes no API). Check each scale renders its band correctly,
      that the 45-day view actually spans two months with both named, that ‹ ›
      and Today behave, that the today line still lands on the right day, and
      that a narrow month segment clips rather than overlapping its neighbor.
      Screenshot the 45-day view.
