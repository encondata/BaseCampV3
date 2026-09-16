# Cascade delete override — Developer › Database › Reconcile

**Date:** 2026-09-15 · **Status:** approved (Jimmy, 2026-09-15: override may destroy everything attached, including time entries and report runs, but only after a preview that names every row; typed confirmation of the record's name; no second password) · **Branch:** `user-detail` (worktree off `main` @ ad84c30)

## Problem

`/dev/database` › Reconcile hard-deletes records marked for permanent deletion. A record still referenced elsewhere fails with `fk_violation` and lists what points at it. Force delete then offers a partial escape: it nulls every nullable referencing column and deletes rows in `PURGE_ROW_TABLES` (`site_clients`, `initiative_people`, `initiative_links`, `container_assets`).

When a required foreign key points at the record, force is refused outright — "Cannot force — some references are required fields." — and the record can never be deleted through the portal. Jimmy hit this on three people at once: every one of them blocked on `person_roles`, and variously on `user_accounts`, `worker_profiles`, `access_group_members` and `time_entries`. There is no way forward from that screen.

Three facts shape the fix:

- **Fourteen** required foreign keys target `people.id`. Ten are rows that mean nothing without the person (account, roles, worker profile, certifications, contact profile, permission overrides, group memberships, membership requests, initiative roster). Four are records of their own: `time_entries`, `notifications`, `report_runs.requested_by`, `label_generation_runs.requested_by`.
- **Six** foreign keys already declare `ON DELETE CASCADE` or `SET NULL`, so the database handles them. `notification_group_members.person_id` is one, yet the failure report lists it as a blocker. That is a reporting bug: it never blocked anything.
- `auth_sessions.person_id` references **`user_accounts.person_id`**, not `people.id`, and `auth_sessions.replaced_by` references `auth_sessions.id`. Deleting a person who has ever signed in therefore needs a transitive walk plus intra-table ordering. A one-hop cascade fails for every such person.

## Design

### Approach

One schema-walking engine computes a plan; the same engine executes it. A preview endpoint returns the plan without writing, and the delete endpoint recomputes it and runs it. The preview cannot drift from the delete because there is one implementation. The engine is generic over `DELETABLE`, so the override works for all nine reconcilable entity types, not just people.

### Engine — `api/src/serversherpa/devtools/cascade.py` (new)

`devtools.py` is already 700+ lines; the walk, its classification rules and its execution live in their own module with `devtools.py` importing two functions.

```python
@dataclass(frozen=True)
class CascadeStep:
    table: str
    column: str
    action: str            # "purge" | "clear" | "db_cascade" | "db_set_null"
    count: int
    labels: list[str]      # up to 3, via the existing _label_expr
    depth: int             # 0 = points straight at the target

@dataclass(frozen=True)
class CascadePlan:
    entity_type: str
    entity_id: uuid.UUID
    label: str
    steps: list[CascadeStep]          # execution order: deepest purge first
    blocked: list[str]                # human-readable; non-empty ⇒ refuse to run
    total_rows_deleted: int           # sum of purge counts
    total_rows_cleared: int           # sum of clear counts
```

`plan_cascade(db, model, entity_id, *, max_depth=6) -> CascadePlan` walks breadth-first from the target row. For every column whose foreign key targets the current row's table primary key:

| Condition | Action | Recurse? |
|---|---|---|
| FK declares `ON DELETE CASCADE` | `db_cascade` | no |
| FK declares `ON DELETE SET NULL` | `db_set_null` | no |
| Column nullable, not check-guarded (`_check_guarded`) | `clear` | no |
| Column nullable but check-guarded | — | recorded in `blocked` |
| Otherwise (required) | `purge` | yes, into rows referencing the purged rows' own primary keys |

Rules that hold regardless of the walk:

- `audit_log` is never purged. Its actor column is nullable so it clears, but an explicit guard refuses to purge that table if the schema ever changes. Deleting a record must not delete the record of deleting it.
- A table already visited at a shallower depth is not revisited; the same (table, column) pair appears once.
- A self-referencing column inside a purged table (`auth_sessions.replaced_by`) gets no step at all. The purge deletes the referencing and the referenced rows in one statement, and the foreign key is plain `NO ACTION`, so PostgreSQL checks it at end of statement and both rows going together satisfies it. Nulling instead would trip `auth_sessions_rotation_pair_check`, which pairs `replaced_by` with `rotated_at`. A self-reference on the target's own table is different and still clears: other people's `people.created_by` pointing at the doomed person is a genuine detach.
- `check_guarded` reads CHECK constraints from the ORM metadata only, so one declared solely in a migration is invisible to it. The blast radius is bounded: such a clear raises an `IntegrityError`, the savepoint rolls back, and the operator sees an ordinary failure report. Nothing half-deletes.
- Exceeding `max_depth` adds to `blocked`. So does any table in `DELETABLE` being reached as a purge target, because deleting another top-level record as a side effect is out of scope: it must be marked and reconciled on its own.
- Steps carry counts measured at plan time. The executor re-runs each statement and reports actual row counts, which may differ if the database changed between preview and confirm.

`execute_cascade(db, plan, model, entity_id) -> dict[str, int]` refuses when `plan.blocked` is non-empty, then applies steps deepest-first: `clear` issues `UPDATE … SET col = NULL`, `purge` issues `DELETE … WHERE col = ANY(ids)`, `db_cascade` and `db_set_null` do nothing. The plan stores counts, not identifiers, so execution re-derives each level's row set by repeating the walk against the live rows. A row added between preview and confirm is therefore destroyed too, which is why the returned counts are the ones written to the audit log. It returns per-table actual counts for the audit row. It performs no commit and no savepoint of its own; the caller owns the transaction.

### API — `api/src/serversherpa/api/routes/devtools.py`

Both endpoints keep the existing gate, `require_permission("devtools", "change")`, which sits behind god mode.

**`GET /devtools/pending-deletes/{marker_id}/cascade-preview` → `CascadePlanOut`** — loads the marker (404 `marker_not_found`), builds the plan, returns it. Read-only; rolls back anything the walk touched by never writing.

**`POST /devtools/pending-deletes/{marker_id}/cascade-delete`** body `{ "confirm_label": "<text>" }` **→ `PendingDeleteReconcileOut`** — recomputes the plan, then:

- `confirm_label` must equal the marker's `entity_label` exactly, after trimming surrounding whitespace on both sides. Mismatch → 422 `label_mismatch`. This is what stops a stale browser tab destroying the wrong record.
- A marker whose `entity_label` is empty → 422 `label_unavailable`; such a record cannot be cascade-deleted from the UI.
- `plan.blocked` non-empty → 409 `cascade_blocked` with the list.
- Otherwise runs inside the same per-marker savepoint the existing reconcile uses, executes the plan, deletes the target row, deletes the marker, and writes one audit row: `entity_type` = the marker's type, `action = "cascade_delete"`, `changes = {"label": …, "deleted_rows": {table: n}, "cleared_references": {"table.column": n}}`.
- Returns the same `PendingDeleteReconcileOut` shape the tab already renders, so a failure still lands in the familiar failure list.

New schemas in `schemas.py`: `CascadeStepOut` (the dataclass fields), `CascadePlanOut`, `CascadeDeleteIn`.

**Reporting fix.** `PendingDeleteReference` gains `db_handled: bool`, set when the foreign key declares `ON DELETE CASCADE` or `SET NULL`. `_find_references` fills it. `canForceDelete` in `portal/src/lib/pendingDeletes.ts` treats a `db_handled` reference as satisfied, and the failure list labels it "handled automatically by the database" instead of listing it as a blocker.

### UI — `portal/src/pages/DevDatabase.tsx`, `portal/src/components/dev/CascadeDeleteModal.tsx` (new)

In the Reconcile tab's failure list, the "Cannot force" dead-end text is replaced by a button, and the button also appears next to Force delete when force is possible but the operator wants everything gone:

> **Override — delete this and everything attached** (`mini-btn sm danger`)

It opens `CascadeDeleteModal`, which loads the preview on mount:

- **Header** (house report-generate pattern): eyebrow "Database", `h3` "Delete <label> and everything attached", `page-hint` "This cannot be undone. Every row listed below is destroyed permanently."
- **Summary**: one line, `c-red` chip — "N rows in M tables will be permanently deleted" — plus "P references will be cleared" when any `clear` steps exist.
- **Plan table**: `DataTable`, columns Table, What happens, Rows, Examples. "What happens" reads "Deleted", "Reference cleared", or "Handled by the database". Purge rows sort first. Examples join up to three labels.
- **Blocked state**: when `blocked` is non-empty the table still renders, the destroy button never enables, and a note lists each reason.
- **Confirmation**: a `pf-form` field labeled `Type <label> to confirm`. The destroy button is disabled until the trimmed input equals the label exactly.
- **Footer**: "Delete permanently" (`btn-solid btn-danger`) and Cancel. While running, both disable and the button reads "Deleting…".
- On success the modal closes, the pending list and the result panel refresh from the server response. On failure the modal stays open and shows the mapped error (`label_mismatch`, `cascade_blocked`, `marker_not_found`, or a generic fallback).

Sizing follows the modal rules already in force: its own card modifier `dev-cascade-card` at `min(880px, 96vw)`, content-matched, dropdowns unclipped. New CSS goes in `portal/src/styles/system.css` under a `dev-cascade-` prefix, layout only, so the list typography guardrail stays green.

## Error handling

- Preview failure (network, 404) → the modal shows "Could not build the delete plan." with a Retry button; the destroy button stays disabled.
- `cascade_blocked` at execute time, when the preview looked clean because the database changed underneath → the modal re-renders the returned reasons and stays open.
- An `IntegrityError` the plan did not foresee rolls back the savepoint exactly as today and reports as an ordinary `fk_violation` failure with its references, so nothing half-deletes.

## Testing

**API — `api/tests/test_devtools_cascade.py` (new), real Postgres:**

- Plan shape for a person with an account, two auth sessions (one replacing the other), a role, a worker profile, an access-group membership and a time entry: sessions appear at depth 1 below `user_accounts`, `replaced_by` appears as a `clear` step, `notification_group_members` is reported `db_cascade` rather than purge, and `audit_log` appears as `clear`.
- Execute removes exactly those rows, leaves an unrelated person's account, sessions, roles and time entries untouched, and deletes the marker.
- `confirm_label` mismatch → 422 and nothing is deleted; whitespace-only difference is accepted.
- Empty `entity_label` → 422 `label_unavailable`.
- A plan reaching another `DELETABLE` record → `blocked`, execute refuses with 409, nothing deleted.
- Audit row exists with per-table counts.
- `max_depth` exceeded → blocked rather than partial execution.
- Non-person coverage: a client with a site link and a contact profile cascades correctly, proving the engine is generic.
- Existing `test_devtools_*` suites keep passing, including force delete.

**Portal — `portal/src/components/dev/CascadeDeleteModal.test.tsx` (new) and additions to `DevDatabase.test.tsx`:**

- Preview renders each step with its action wording and counts.
- The destroy button is disabled until the typed label matches, including a trailing-space case.
- Confirming posts `confirm_label` and closes on success.
- `label_mismatch` and `cascade_blocked` keep the modal open with their messages.
- A blocked plan never enables the button.
- The failure list shows "Override" where it used to show "Cannot force", and a `db_handled` reference no longer counts against `canForceDelete`.

**Live verification** on the dev stack: cascade-delete Ben Mundon (account + roles), then Guido Huizing (account + roles + worker profile + access group), then Jimmy Henderson (adds a time entry and an initiative roster row) — screenshot the preview for each, confirm the rows are gone from their own pages afterwards, and check the audit log entry.

## Out of scope

- Cascading into another record that is itself reconcilable; those must be marked separately.
- Undo. The Backups tab is the recovery path, and the modal copy says so implicitly by warning the action cannot be undone.
- Changing which entity types are reconcilable, or the god-mode gate itself.
- Bulk cascade. The Reconcile button keeps its safe semantics; override is always per record.
