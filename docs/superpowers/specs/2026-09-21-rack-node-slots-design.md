# Rack node slots: collisions, drawings and the model form factor

**Date:** 2026-09-21
**Status:** Approved in conversation (Jimmy, 2026-09-21); proceeding to plan.
**Example:** initiative `a1330cc7-ff79-44fa-9e83-e692796e4bb6` ("Las Vega 3
Cluster Move"), source rack `09.01.05D.02.10` to destination
`14.03.02B.01.10`.

## Problem

Multi-node chassis (Dell Isilon H5600 and the like) hold two to four
compute nodes inside one rack-mounted enclosure. The From-To convention
for that is a fractional RU: the chassis sits at `33`, its nodes at
`33.1` through `33.4`. The roster stores this faithfully
(`initiative_assets.destination_ru` is `Numeric`, so `33.1` survives
import and edit), but both collision checks throw the fraction away:

- The importer's `flag_collisions` (`imports/move_assets.py`) does
  `int(float(destination_ru))`, so the chassis and every node land on
  RU 33 with a default height of 1 and all five collide pairwise.
- The Move Report's `collisions()` (`reports/move_report/compute.py`)
  already parses the slot (`round((raw - base) * 10)`) and has a
  `slot_conflict` kind, but still puts the node's base RU into its
  occupied set, so nodes still surface as `ru_overlap`.

On the example initiative that means 41 of 46 rows on one rack are
`location_collision`: nine chassis and 32 nodes, none of which actually
collide. The five rows that are not chassis or nodes are fine.

The rack elevation has the same blind spot. `rackLayout()`
(`portal/src/lib/initiatives.ts`) passes `ru: 33.1` straight through
with height 1, so nodes draw as four 1U blocks fractionally offset over
the chassis. The server-side rack renderer reuses that same portal code
under Node, so the report drawing is wrong in the same way.

Two secondary findings shape the design:

1. Both models in the example were **force-created by the import with
   no specifications** (`Dell Isilon H5600`, `Dell H5600 node`;
   `ru_size` and `mount_type` both empty). Any rule that depends on a
   flag on the model is off until someone edits the catalog by hand.
2. The catalog **already has the right models**, imported from V2 with
   the concept in the name: `DellEMC Isilon H5600 (Chassis)` and
   `DellEMC_Isilon H5600 Storage (Node)`, both with zero assets. The
   matcher missed them because of the `DellEMC_` prefix and the
   parenthetical suffix.

## Decision

**Treat `N.x` as "slot x of RU N" by convention, and make that the
thing collision detection depends on.** Add a `form_factor` on the make
and model as a second phase for the things that genuinely need it
(drawings, the rail report, a sharper orphan check). The convention
handles the unflagged case, which is the common case, because the
importer creates spec-less models.

Applied to the example initiative the collision fix takes 41 flags to
zero with no data edits, and stays at zero if the chassis height is
later set to 4, because the chassis spans then land at 1 to 4, 5 to 8,
and so on without touching each other.

## The placement rule

One pure function, shared by the importer and the report so they cannot
drift again, that turns a list of placed rows into collisions and
orphans. A placement is `(rack, base, slot, height)` where `base =
floor(ru)`, `slot = round((ru - base) * 10)` and `height` is the model
`ru_size` or 1.

| Row kind | Occupies | Contributes a span |
|---|---|---|
| Integer RU (`slot == 0`) | RUs `base .. base + height - 1`, slot 0 | yes |
| Fractional RU (`slot > 0`) | the single cell `(base, slot)` | no |

Pairwise within a rack:

- Two spans that share an RU: **`ru_overlap`**. Unchanged from today.
- Two fractional rows at the same base and slot: **`slot_conflict`**.
  Today this is reported as `ru_and_slot_conflict` because of the
  spurious span; that kind is retired.
- A fractional row whose base RU is the **start** of an integer row on
  the same rack: **contained**, not a collision. This is the whole fix
  for the example rack.
- A fractional row whose base RU is **covered by a span that starts
  elsewhere** (a 2U server at 32 reaching up into 33, with a node at
  33.1): **`ru_overlap`** between the node and that span. The node
  claims a chassis that is not there.
- A fractional row with **no integer row starting at its base**:
  **orphan**. Surfaced as a review item, never a collision.

Slot 0 is never a slot conflict (two integer rows at the same RU are a
plain overlap). Rows with no rack or no RU are not placed, as today.

Half-height devices (`3.5` on rack `BJ01` in the example) are the one
honest limitation: the convention reads `3.5` as slot 5 of RU 3 and,
with nothing at 3, reports an orphan. That is the correct behavior for
the information available; the form factor in phase two is what settles
it, because a model flagged `standalone` at a fractional RU is a data
error worth surfacing rather than a node.

## Statuses

`location_collision` stays exactly what it is: the row is in a real
collision. It is set by the importer after a commit pass and by the new
re-check action, and is never set by a manual edit.

A new asset status `orphan_node` (label "Orphan node", red-orange,
`progress_weight` null, same vocabulary as `location_collision`) marks a
fractional-RU row with no chassis at its base. It is a review state, not
a workflow stage. Both statuses are only ever *applied* to rows whose
current status is `loaded_in_system`, `location_collision` or
`orphan_node`; a row that has progressed (labeled, racked, complete...)
is never dragged back by a placement check. Both are *cleared* back to
`loaded_in_system` by a re-check that no longer finds the condition.

Setting these statuses is not a manual status edit and does not go
through `record_status_edit`; it matches the importer's existing
behavior of stamping the status directly.

## Re-check

A new endpoint `POST /initiatives/{id}/assets/recheck-placement`
(permission `initiatives:change`, global scope) runs the placement rule
over the whole destination roster and applies the status transitions
above. It returns `{flagged_collisions, flagged_orphans, cleared}` and
writes one audit row. The importer calls the same function after its
commit pass instead of its own copy.

The portal exposes it as a **"Re-check placement"** action in the
initiative detail page's Assets panel, visible to anyone with change
permission, with a toast summarizing the result. This is how the example
initiative's 41 stale flags get cleared without re-uploading the file.

Roster edits through `PATCH /initiatives/assets/{assoc_id}` do **not**
auto-run the check. A user correcting rack positions one row at a time
would see statuses flicker; the explicit action is the better tool.

## Rack elevation

`rackLayout()` gains slot awareness:

- An integer-RU row is a block as today: `ru = base`, `height`.
- A fractional-RU row whose base is the start of a block on the same
  side becomes a **child** of that block: `{ id, label, slot }` on the
  parent's new `children` array, sorted by slot. It is not a separate
  block and does not take a lane.
- A fractional-RU row with no parent block is drawn as a 1U block at
  `ru = base` with a dashed outline and an "orphan" marker, so it is
  visible rather than silently dropped.

`RackElevation` draws children as equal vertical sub-cells across the
parent's face, each labeled, inheriting the parent's category color at
reduced opacity, with the slot number. The hover card for a child names
its parent. The device list under the drawing lists children indented
under their chassis with the RU shown as `33.1`.

Because the server-side report renderer runs this same portal code
under Node, the Move Report's rack drawings pick this up with no
report-side change. The report's device list rows use the same
`deviceListRows()` helper and inherit the indentation.

## Phase two: model form factor

Migration `0068` adds `asset_models.form_factor text null` with values
`standalone`, `chassis`, `node`. Null means unknown. Consumers that need
a value (the rail report, the drawings) treat null as `standalone`; the
placement rule never infers a mismatch from a null, because the common
case is a model the importer created with no form factor at all. The vocabulary is a module constant next to
`MOUNT_TYPES`, validated on write (`422 unknown_form_factor`), exposed
in the model API, editable in the portal's Makes / Models editor as a
three-option select with a short explainer, and shown as a small chip in
the models list.

The same migration seeds the `orphan_node` status value and sets
`form_factor` on the catalog rows that already say so in their name:
`chassis` where the model contains `(Chassis)` or `Chassis`, `node`
where it contains `(Node)` or ends in ` node` (case-insensitive). That
covers the sixteen V2-imported chassis and node models and the two
force-created ones on the example initiative. The import infers nothing
new at import time; a wrong inference is worse than a blank.

Where the form factor earns its keep:

- **Placement rule.** A row whose model is `node` at an integer RU, or
  whose model is `standalone` at a fractional RU, is reported as a
  **`form_factor_mismatch`** orphan (same `orphan_node` status, distinct
  reason in the result and the audit row). A `chassis` model contributes
  its span exactly as any integer row does; the flag changes nothing
  about spans.
- **Rail report.** Rows whose model is `node` are excluded from
  `rail_summary()`; nodes have no rails. The load summary still counts
  their weight, because they are moved as separate items.
- **Rack elevation.** No behavioral change; the convention already
  places them. A `node` model at an integer RU draws with the orphan
  marker, matching the rule above.

## Phase three: matcher normalization

`normalize_model_key` is the lookup key for every catalog match in the
importer, exact rows and aliases alike: underscores become spaces,
parentheses are dropped, a trailing height token such as `4U` is removed,
whitespace collapses and case folds. Every word is kept, because
`(Chassis)` and `(Node)` are what tell two real catalog rows apart. The
normalized form is used for **lookup only**; stored make and model are
never rewritten.

That closes the accidental-duplicate cases (`DellEMC_Isilon H5600
Chassis 4U` now finds `DellEMC Isilon H5600 (Chassis)`). It does not,
and should not, bridge `Dell H5600 node` to `DellEMC_Isilon H5600
Storage (Node)`: the import string has no `Isilon` and the catalog row
has no bare `Dell`. Those two force-created models stay in the catalog
with their 41 assets; the migration's form-factor backfill gives them the
right form factor, and the next import of the same strings matches them
exactly as it already does. Folding them into the V2-imported rows is a
merge-tool job (a separate parity item).

## Out of scope

- A model merge or forced-reconcile tool (a separate parity item).
- Auto-inferring `form_factor` at import from the model name or from
  observed RU patterns.
- Half-height devices as a first-class concept.
- Re-checking on every roster edit.
- Source-side collisions. Both checks are destination-only today (V2
  semantics) and stay that way; the rack drawing is side-aware already.

## Testing

- **Placement rule** (pure, `api/tests/test_placement.py`): every row
  of the rule table above, including containment, cover-from-below,
  same-slot, orphan, slot 0 never a slot conflict, other rack, no rack,
  the `3.5` case, and each form-factor mismatch. Existing report tests
  (`test_move_report_compute.py`) are updated for the retired
  `ru_and_slot_conflict` kind and the new containment behavior; the
  importer test (`test_move_asset_import_commit.py`) gains a
  chassis-plus-nodes fixture that must produce zero flags and a
  nodes-without-chassis fixture that must produce orphans.
- **Re-check endpoint**: flags, clears, never touches progressed rows,
  audits once, 403 below `initiatives:change`, 404 on the wrong scope.
- **Migration 0068**: upgrade seeds the status and backfills the form
  factor on name-matched models only; downgrade removes both.
- **Model API and editor**: round-trips `form_factor`, rejects an
  unknown value, the portal select and chip render each value.
- **rackLayout / RackElevation**: children attach to the right parent,
  orphans draw dashed, a chassis with four children renders four
  labeled sub-cells, the device list indents children, and the
  server-side renderer snapshot for a chassis rack changes accordingly.
- **Matcher**: each normalization case, and the H5600 pair specifically.
- **Live**: on the example initiative, "Re-check placement" takes 41
  flags to zero, the rack drawing shows nine chassis with their nodes
  inside, and the Move Report's collision section is empty.

## Sequencing

1. Placement rule, shared by importer and report; retire the importer's
   private copy. Tests.
2. `orphan_node` status and the re-check endpoint plus portal action.
3. Rack elevation children and orphan marker, portal and (by reuse)
   report.
4. Migration 0068, model API, editor, chip, backfill.
5. Form-factor use in the placement rule and rail report.
6. Matcher normalization.
7. Live verification on the example initiative.

Steps 1 to 3 need no migration and deliver the fix the user asked for.
Steps 4 to 6 are the enrichment. Each step is a separate task in the
plan.
