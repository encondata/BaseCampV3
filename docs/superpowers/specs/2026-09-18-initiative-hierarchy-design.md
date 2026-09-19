# Initiative hierarchy in the list, timeline and calendar — design

**Date:** 2026-09-18
**Branch:** `initiative-hierarchy`, off `main` @ `9fdfc71`

## Problem

`initiative_links` records that one initiative contains another (a project
contains its events; any type may parent any type; the API enforces
acyclicity). Today the list shows that only as a `Links` count column, off by
default, and the timeline and calendar ignore it entirely. Jimmy wants the
hierarchy to be visible as structure — "more than just a column" — in all three
views.

## Decisions taken with Jimmy

| Question | Decision |
|---|---|
| A child with two parents? | **Refused.** The list is a strict tree. The API rejects a second parent link (`409 already_has_parent`); a UI-only guard could be bypassed. |
| Layout in the list? | **Nested tree rows** with a chevron and child count on parents, children indented beneath, the link's `role` as a chip after the child's name. One virtualized list of mixed row kinds — the mechanism the Containers grouped view already uses. |
| Scope? | List, **and** the timeline and calendar views. |

## Data

`GET /initiatives` items gain `parent_id: uuid | null`, computed in the query
that already produces `links_count`, under the **same visibility filter**. A
parent the actor cannot see comes back as `null`, so the child renders top-level
rather than pointing at an id whose existence would leak (the invariant at
`routes/initiatives.py:166-168`, extended). Nothing else about the payload
changes; the timeline page already consumes `listInitiatives()`, so it receives
`parent_id` for free.

## The tree, built once

`buildInitiativeTree(items, matched, collapsed)` in `portal/src/lib/initiatives.ts`
is pure and shared by both pages. Given the full item set, the set of ids that
pass the page's own filters, and the set of collapsed parent ids, it returns a
flat `InitiativeTreeRow[]` in render order, each carrying `item`, `depth`,
`hasChildren`, `childCount`, `expanded`, `isContext` and `role`.

- **Roots** are items with `parent_id === null` **or** whose parent is not in
  the item set (an out-of-scope parent). Recursive to any depth.
- **Filters show ancestors as context.** A row whose item is in `matched`
  renders normally. An ancestor that is *not* in `matched` but has a matched
  descendant still renders, flagged `isContext` — dimmed, not counted, not
  selectable — so the child keeps its place. Children float to the top only
  when their parent is genuinely invisible to the actor.
- **Collapsed** parents render their own row (with the chevron pointing right and
  the count) and none of their subtree.
- **Sorting is within siblings**: the caller passes items already sorted; the
  builder preserves that order among each node's children and among roots. A
  global sort interleaving children among unrelated parents would destroy the
  tree.

The collapsed set persists per browser in `localStorage` under
`initiatives.collapsed` (try/catch, the `containers.view` idiom), **shared by
the list and the timeline**, so collapsing a project in one view collapses it
in the other. Expanded is the default: with a handful of initiatives,
collapsed-by-default would hide the structure the feature exists to show.

## The list (`Initiatives.tsx`)

Rows come from `buildInitiativeTree(visibleSorted, matchedIds, collapsed)`
instead of `visible` directly. The chevron, child count and per-depth indent
live in the existing `.cell-primary`; the role chip follows the name on child
rows; context rows get a `context` class. The result count and select-all count
only non-context rows. Status, client, site, dates, god-mode editing and the
row-detail expansion are untouched. Sorting by any column sorts siblings.

## The timeline (`InitiativeTimeline.tsx`, `view === 'timeline'`)

The same tree drives the rows: chevron, count and indent in `.itl-row-label`;
collapsed parents hide their children's rows; the page's type/status/client
pills produce `matched`, so ancestors appear as context here too.

**A parent without its own dates gets a derived span.** Today a dateless
initiative drops below the "Unscheduled" divider. A dateless *project* whose
events are scheduled must instead stay with its children, and the honest answer
to "when is this project?" is the envelope of its events. So a parent with no
`scheduled_start`/`scheduled_end` but at least one scheduled descendant renders
an **outline bar** from the earliest descendant start to the latest descendant
end, visually distinct from a real bar (dashed border, no fill, title
"Derived from N scheduled initiatives"). Only roots with no dates *and* no
scheduled descendants go below the divider. A parent with its own dates keeps
its own bar; the derived envelope is never drawn over real dates.

## The calendar (`view === 'calendar'`)

A month grid has no rows, so there is no indent or chevron. The hierarchy shows
in two ways:

1. **The shared collapsed set applies.** A project collapsed on the timeline
   hides its children's segments on the calendar too, so the two views agree
   about what is expanded.
2. **Child segments carry their parent.** A child's label and title read
   `Parent › Child`, so provenance is visible without leaving the grid.

The derived envelope is **timeline-only**. On a calendar it would double-cover
every day its children already cover and read as clutter; the calendar shows
real dates only.

## Enforcing one parent

`POST /{id}/links` refuses with `409 already_has_parent` when `body.child_id`
already appears as `child_id` in `initiative_links`. The check sits beside
`duplicate_link` and `circular_link`; `portal/src/lib/initiatives.ts:80`'s error
map gains the sentence. Existing data is unaffected — there are no multi-parent
rows — but the tree builder still tolerates one defensively by using the first
link it sees, so a legacy row can never crash the page.

## Testing

`buildInitiativeTree` is table-driven: a three-level chain; a collapsed middle
node hiding its subtree; a filtered child pulling its parent in as context; a
parent absent from the item set yielding a top-level child; sibling order
preserved from input; a defensive multi-parent row appearing once. The derived
span has its own pure helper with cases for no children, all-unscheduled
children, and mixed. API tests pin `parent_id` under visibility (an out-of-scope
parent → `null`) and the `already_has_parent` refusal.

## Deliberately not doing

- No drag-to-reparent, no reordering of siblings from the list. Links are
  created and removed on the detail page as today.
- No change to the detail page's Links panel beyond the new error message.
- No derived spans on the calendar (above).
- No global sort across the tree (above).
