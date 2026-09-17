# Clear offline and expired kiosk devices — design

**Date:** 2026-09-17
**Branch:** `kiosk-clear-offline`, off `main` @ `0af9b35`
**Related:** the Kiosk Devices page (`portal/src/pages/KioskDevices.tsx`), the device
registry (`api/src/serversherpa/api/routes/devices.py`, migration 0037/0040/0041)

## Problem

`/hardware/kiosks` accumulates rows that no longer correspond to anything running:
kiosks whose registration token lapsed, and rows created by a pairing attempt that
never came back. Clearing them one at a time through the row menu is the only option
today. Jimmy asked for a single button that clears the dead ones.

## The match rule

A kiosk is clearable when **both** of these hold:

1. **Not registered** — `token_expires_at IS NULL` (Unregistered) **or**
   `token_expires_at < now()` (Expired). *Expires soon* is still a valid
   registration and does not match.
2. **Not seen recently** — `last_seen_at IS NULL` **or**
   `last_seen_at < now() - interval '24 hours'`.

Scoped to `device_type = 'kiosk'`.

**Both, not either.** Jimmy's phrasing was "not registered *or* not seen in 24
hours", and the choice was made deliberately against it. `OR` deletes two kinds of
kiosk that are obviously alive: one heartbeating right now whose token happens to
have lapsed (it needs re-registering, not deleting), and one registered five minutes
ago that has not checked in yet, whose `last_seen_at` is still NULL. `AND` clears
genuinely dead rows and nothing else.

| Kiosk | Registration | Last seen | Cleared |
|---|---|---|---|
| `kiosk-dock-01` | Expired | 3 days ago | yes |
| `kiosk-pi-07` | Unregistered | never | yes |
| `kiosk-lab-02` | Registered | 2 days ago | no — token valid |
| `kiosk-live-04` | Expired | 10 minutes ago | no — demonstrably alive |
| `kiosk-soon-05` | Expires soon | 5 days ago | no — still registered |

**Both comparisons use the database clock**, never the browser's. A skewed laptop
must not decide what "24 hours" means for an irreversible delete.

## `clear` means permanent deletion

`devices` has no `archived_at` column and `DELETE /devices/{id}` is a hard delete.
This button does the same thing in bulk rather than introducing a second, softer
notion of removal on the same page. One audit row per deleted device, carrying name,
device_type and serial — matching the existing per-row delete. A kiosk that returns
later re-registers by serial and gets a fresh row.

## API

One endpoint, one rule, two modes.

- `POST /devices/kiosks/clear-offline` `{"dry_run": true}` → returns every matching
  kiosk (`id`, `name`, `sub_type`, registration state, `last_seen_at`) and deletes
  nothing. This is what fills the confirmation modal.
- `POST /devices/kiosks/clear-offline` `{"dry_run": false, "ids": [...]}` →
  **re-evaluates every id against the same rule** before deleting, then returns
  `{"kiosks": [...], "skipped": [...], "not_found": N}`. `kiosks` is what was
  actually deleted (named to match the dry-run field, since this is the same
  list before and after confirmation). `not_found` counts ids that matched no
  kiosk at all — already deleted, the wrong device type, or never existed — so
  the operator's confirmed count reconciles against
  `len(kiosks) + len(skipped) + not_found`. `ids` is capped at 500 entries.

Registration state is one of three values: `unregistered` (no token ever issued),
`expired` (token lapsed before `now`), or `registered` (a valid, future token).
`registered` only appears in `skipped` — a `kiosks` entry is always unregistered or
expired by construction — and covers the case where a kiosk re-registers in the
window between the preview and the confirm; it must not be reported as `expired`.

The re-check is the point, and it buys two things. The endpoint cannot be used to
delete an arbitrary device id — anything passed in `ids` that does not match the rule
is skipped, not deleted, and the query itself is scoped to `device_type = 'kiosk'`,
so the endpoint never even describes a non-kiosk device. And a kiosk that heartbeats
in the seconds between preview and confirm is **spared**, because by then it no
longer matches. The success notice reports what actually happened ("Deleted 2
kiosks · 1 skipped, seen just now") rather than what was predicted.

## Authorization — two gates

```python
actor: AuthContext = require_permission("scanning_hardware", "delete")
...
if actor.access.max_rank < GATE_BYPASS_RANK:      # 60 == admin
    raise _err(403, "forbidden_rank")
```

Both are required, and on today's seeded matrix they look redundant: `staff` holds
only `scanning_hardware: ("view",)`, so staff cannot delete a device at all. But the
permission matrix is **editable at runtime** through the access admin page. The
moment an admin grants staff `scanning_hardware:delete`, staff would inherit this
bulk button too. The rank check makes that impossible however the matrix is edited.
Permission governs the resource; rank governs this particular irreversible bulk
action. The idiom is lifted from `api/routes/access.py:107`.

`admin` is rank 60, exactly `GATE_BYPASS_RANK`, so the gate admits admin,
super_admin, founder and developer.

## Portal

A `Clear offline and expired` button in the Kiosk Devices page header opens
`ClearOfflineKiosksModal`: the house modal header (eyebrow / title / description)
over a real table of the matches — name, sub-type, registration state, last seen —
with Cancel and `Delete N kiosks`.

An empty match renders "Nothing to clear — every kiosk is either registered or has
been seen in the last 24 hours" with a Close button only, rather than an enabled
button that does nothing.

The button is **hidden**, not disabled, below rank 60. A disabled destructive control
invites "why can't I click this?" and advertises a capability the viewer will never
have. `useAuth().maxRank` drives it.

## Testing

The match rule is a pure predicate over (`token_expires_at`, `last_seen_at`, `now`),
so its cases are table-driven and cover every row of the table above, including the
*Expires soon* + stale case that must survive.

Several API tests carry specific weight:

- A staff actor **with `scanning_hardware:delete` explicitly granted** still gets
  403. This is the case that silently regresses if someone later decides the rank
  check is redundant and removes it.
- An id passed in `ids` that does not match the rule is skipped, not deleted — the
  endpoint is not a general-purpose delete. Survival is asserted by re-querying the
  database for the row, not by trusting the identity map, which would report a
  deleted row as present regardless of what actually happened.
- A kiosk whose `last_seen_at` moves between the dry run and the confirm is spared,
  and reported as skipped.
- A kiosk whose token is renewed between the dry run and the confirm is spared and
  reported as skipped with registration `registered`, never `expired`.
- A non-kiosk id is neither deleted nor described, and counts toward `not_found`.
- An id matching no device at all counts toward `not_found`.
- `ids` past its 500-entry cap is rejected with 422.
- The match uses the database clock even when the application host's clock is
  skewed — proven by monkeypatching the route module's `datetime.now()`.

Portal tests cover the modal's populated and empty states, and the button's absence
for an actor below rank 60.

## Deliberately not doing

- **No configurable window.** 24 hours is hardcoded to match the button's own label.
- **No guard for a kiosk assigned to an active initiative.** Under AND semantics such
  a kiosk would have to be both unregistered and silent for a full day, at which
  point it is not running that initiative anyway.
- **No soft delete.** Adding `archived_at` to `devices` would mean an archive/restore
  path across all four hardware pages — far more than this button warrants.
