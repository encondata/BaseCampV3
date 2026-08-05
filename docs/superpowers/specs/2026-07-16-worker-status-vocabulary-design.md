# Workers: read the status vocabulary instead of hardcoding it

Date: 2026-07-16
Follows: `2026-07-15-status-values-design.md` (the `status_values` table + Variables page)

## Problem

`status-values` made worker statuses editable data: they live in `status_values`
under `record_type='worker'`, a developer creates them from `/dev/database/variables`,
and `PUT /workers/{id}/profile` validates against the table at runtime.

The portal never caught up. A new worker status is **API-assignable but not
portal-assignable**. Four places hardcode exactly `active`/`standby`/`blacklist`:

| Where | Symptom on an unknown status |
|---|---|
| `Workers.tsx` `STATUS_META` | chip renders via fallback — raw key, grey |
| `Workers.tsx` `PILLS` | not filterable |
| `Workers.tsx` edit `<select>` | not selectable |
| `OrgDirectory.tsx` `WORKER_STATUS_CLS` | chip grey |
| `OrgDirectory.tsx` `breakdown` | **counted, then never rendered** — silently absent |
| `schemas.py:439` | stale comment `# active \| standby \| blacklist` |

The rollup case is the worst: `breakdown` accumulates `b[w.status]` dynamically but
renders three hardcoded chips, so the count is computed and thrown away.

## Prior art, accurately

"Make it symmetric with Sites" needs care — Sites splits status rendering across
**two** sources, and only one is `listSiteStatuses()`:

- **Chips** read `status_label` / `status_color`, which the *server* denormalizes
  onto every row (`sites.py:70-76`), falling back to `(status, "c-slate")`.
- **Facet options** (`Sites.tsx:150`) and the **edit select** (`SiteEditModal.tsx:232`)
  read `listSiteStatuses()`.

Sites also has **no status pills** — status is a Filters facet. Its `.segmented`
slot holds a List/Map view toggle, which Workers has no equivalent of.

## Design

Adopt both halves of the Sites split.

### API

`status/labels.py` (new):

```python
async def status_labels(db, record_type: str) -> dict[str, tuple[str, str]]:
    """key -> (label, color) for one record type's vocabulary."""
```

Lives in `status/` because that package already owns the record-type concept, and
because **two** routes build `WorkerItem` — `workers.py:list_workers` and
`stakeholders.py:list_partner_workers` — which must not drift. `stakeholders.py`
has no precedent for importing from `workers.py`.

Deliberately does **not** filter `is_active`, matching `sites.py:_labels`: a worker
on a retired status must still render, and the portal resends `status` on every edit.

- `schemas.py`: `WorkerItem` gains `status_label: str`, `status_color: str`; the
  stale vocabulary comment goes.
- Both builders use the helper with the `sites.py:72` fallback: `(status, "c-slate")`.
- `sites.py`'s own `_labels` is left alone — it also loads site types, and
  refactoring a working page is out of scope.

### Portal

- `api.ts`: `listWorkerStatuses(): Promise<StatusValue[]>` beside `listSiteStatuses()`.
- `Workers.tsx`: delete `STATUS_META`, `PILLS`, `pill` state, `counts`, and the
  `.segmented` div. Status becomes a facet. Chips read `w.status_color` /
  `w.status_label`. `statuses` threads `Workers → WorkerDetail → ProfileForm` on the
  path `levels` already takes. Select mirrors `SiteEditModal.tsx:232`.
  `.toolbar-right` is `margin-left:auto`, so removing `.segmented` needs no CSS change.
- `OrgDirectory.tsx`: delete `WORKER_STATUS_CLS` with **no** replacement fetch — the
  rollup groups by the rows' own denormalized fields, so it renders every status
  present. Modal chip upgrades from raw key to label.

## Decisions

- **The client-side chip fallback is deleted, not kept.** The server now always sends
  a non-empty `status_label` (falling back to the raw key), so
  `?? { label: worker.status, cls: 'tag' }` is unreachable. A dead branch implying a
  hazard the server already closed is worse than no branch.
- **`blacklist` stays a literal** in the note-required branch, commented against the
  `worker_profiles` CHECK and the rank rule. Data-driving it (a `requires_note`
  column) is YAGNI until a second status needs it.
- **Sort by `status_label`, not the raw key.** The column displays the label, so
  sorting by key puts a `wip` key labelled "Active" under W.
- **The rollup sorts chips alphabetically by label.** `sort_order` isn't denormalized;
  alphabetical is deterministic without adding a third field. Loses the fixed
  active→standby→blacklist order.
- **The edit select seeds a missing option from `worker.status_label`.** A worker on a
  *retired* status isn't in `listWorkerStatuses()` (that route filters to active), so
  the select would render blank and misread as "no status set". The row already
  carries its label, so the option costs no fetch. This is one step better than Sites.

## Verification

The API half is covered by tests: label/colour on both routes, and the retired-status
fallback to raw key + `c-slate`.

The portal half needs a human pass — the portal is login-gated, so no agent can drive
it. Create a worker status via Variables, assign it, then check the chip, the Status
facet, and the select.
