# Timeline: 45-day scale and month bands — outcome

Plan: `docs/superpowers/plans/2026-09-15-timeline-45-day-scale.md`. Branch
`timeline-scale` off `reports` @ 6091e0b, three commits.

Jimmy, looking at the timeline ruler: "can we show 45 days? we should also list
the month and not just 1-30."

| Commit | |
|---|---|
| `4cbe915` | `lib/timeline.ts`: the `'45d'` scale and `monthBandsFor()` |
| `f5947f9` | the scale pill, the band row, its CSS |
| `48a9115` | the step is six whole weeks, said outright |

## What it does

**45 days** sits between Month and Quarter. The range runs from the Monday of
the anchor's week for 45 days, so the current week stays whole and visible
rather than the window starting mid-week. Ticks are daily at the same 32px
density as the Month scale, so the pane scrolls — that is expected.

**The ruler now names its months.** A band above the day numbers carries one
segment per calendar month the range covers, positioned over that month's own
span, labelled `MMM YYYY` so a range crossing New Year stays unambiguous. It
shows on the month, 45-day and quarter scales. The year scale does not get one:
its ticks are already month names.

A narrow segment clips its label rather than painting over its neighbor — the
same rule the list-overlap work established earlier today.

## The step is 42 days, deliberately

The range snaps to the anchor week's Monday, so stepping the anchor by 45 days
landed mid-week and snapped back to the same Monday + 42 anyway. The code now
steps 42 and says why. Consecutive views therefore share their last three days.
That overlap is useful rather than a gap: a run straddling the boundary appears
in both views.

## Verification

- Full portal suite **1766 passed** across 173 files; `npm run build` and
  `npx tsc -b` clean. Eighteen new tests: twelve in the pure module, six on the
  page.
- Live, against the shared dev API:

| Check | Result |
|---|---|
| 45-day scale | 45 ticks, Sep 14 → Oct 28, today being Sep 15 |
| Bands on it | `Sep 2026` at 0% for 37.8%, `Oct 2026` for the rest — 17 and 28 days of 45 |
| Month scale | 30 ticks, one `Sep 2026` band |
| Quarter | 13 week ticks, bands `Jul 2026` / `Aug 2026` / `Sep 2026` |
| Year | month ticks, no band, as designed |
| ‹ | Sep 14 → Aug 3, exactly 42 days, bands follow to `Aug`/`Sep` |
| Today | returns to Sep 14 |
| Scale preference | persists as `45d` and is honored on reload |

## Known, pre-existing

Stepping to a range with no initiatives replaces the whole grid — ruler
included — with "No initiatives in this range." You then cannot see where you
are or which way to step back. That predates this change, but the 45-day scale
makes it easier to hit. Worth keeping the header and showing the empty state
only in the rows area.
