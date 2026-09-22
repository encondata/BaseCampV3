# Merge duplicate models and catalog review — design

**Source:** parity sheet Gaps row 5 (Assets): "Merge duplicate models — fold a
duplicate catalog entry into the correct one and move its assets across", plus
the related "Forced-reconcile cleanup queue" row. Both live on the portal's
Makes / Models page (`/assets/models`).

**V2 being ported:** one merge call re-pointed assets and aliases to a target
and hard-deleted the duplicate (specs discarded, no audit, no server-side
permission check; the dialog promised an alias that was never written). The
forced-reconcile queue listed models the importer had created by guessing
(tagged in the notes text) with reassign / edit / delete actions.

**Decisions (Jimmy, 2026-09-22):** scope = merge action plus a Review view
(importer-created models and likely duplicates); on merge, the target's blank
specs are filled from the duplicate, and the duplicate's notes are appended.

## V3 today (unchanged facts)

`asset_models` (make + model unique, case-insensitive), `asset_model_aliases`
(alias globally unique, cascade on model delete), and three references to a
model: `assets.model_id`, `asset_model_aliases.model_id`, `stock_lines.model_id`
(set null on delete). The importer tags models it created with a `knowledge`
value beginning `FORCED:`. `imports/move_assets.py::normalize_model_key` is the
name normalizer the importer matches with. There is no delete or merge
endpoint and no "assets using this model" query.

## Schema

Migration `0070_model_review_dismissed` (revises 0069): `asset_models.review_dismissed_at`
timestamptz, nullable, no default. ORM `AssetModel.review_dismissed_at: datetime | None`.
`AssetModelItem` gains `review_dismissed_at`.

## Feature 1: Merge

### API

`POST /asset-models/{target_id}/merge` — body `{"source_id": uuid, "dry_run": bool}`.
Gates: `asset_models:change` and `_require_global`, like PATCH.

Errors: 404 `asset_model_not_found` (either id); 409 `cannot_merge_self`;
409 `alias_conflict` on a real run when the plan has conflicts.

Response `MergePlan`:

```json
{"target": ModelSummary, "source": ModelSummary,
 "moves": {"assets": n, "stock_lines": n, "aliases": n},
 "fills": {"ru_size": 2, "weight_lbs": 50.0, "weight_kg": 22.68, ...},
 "alias_added": "Dell R740 " | null,
 "aliases_after": ["..."],
 "conflicts": [{"alias": "...", "model_id": "...", "make": "...", "model": "..."}],
 "can_merge": bool, "applied": bool}
```

`ModelSummary` = `AssetModelItem` fields plus `asset_count` and `stock_line_count`.

Plan rules (the same function builds the dry run and drives the real run):

- **Moves:** every asset and stock line whose `model_id` is the source is
  re-pointed to the target. Every source alias moves to the target, except
  one that equals (case-insensitively) the target's own "make model" or an
  alias the target already has (those are dropped, counted in `aliases` only
  when moved).
- **Alias added:** the source's own `"{make} {model}"` becomes a target alias
  unless it equals the target's name or an existing target alias
  (case-insensitive). Then `alias_added` is null.
- **Conflicts:** a source alias, or the source's name, that a **third** model
  owns as an alias. Reported with the owner; `can_merge` is false while any
  exist. (The source's name cannot be a third model's *name* because of the
  unique constraint.)
- **Fills:** for each of `category`, `ru_size`, `mount_type`, `rail_type`,
  `form_factor`: when the target's value is null/empty and the source's is
  not, the source value fills it. Unit pairs fill as pairs: `weight_lbs`+
  `weight_kg` when both target values are null and the source has either;
  likewise `length/width/height_in` with `_cm` as one group of six. Fills are
  reported with the exact values written.
- **Notes:** target `knowledge` becomes
  `target.knowledge.rstrip() + "\n\nMerged from {make} {model} on {YYYY-MM-DD}."`
  followed by `"\n" + source.knowledge.strip()` when the source has notes.
  Leading blank lines are trimmed when the target had no notes.
- **Delete:** the source row is deleted (its remaining aliases cascade; none
  remain after the move).
- **Audit:** one row on the target, `entity_type="asset_model"`, `action="merge"`,
  `changes={"source_id", "source_make_model", "moves", "fills", "alias_added",
  "aliases_moved": [...]}`; one row for the source, `action="merged_into"`,
  `changes={"target_id", "target_make_model"}` so its history is findable.
- **Transaction:** one commit at the end; nothing is written on a dry run.
- Updated `updated_at` on the target.

### Dialog

`ModelMergeModal` (report-generate header: eyebrow "Catalog", title
"Merge into another model", hint). Opened from the expanded row's action bar
("Merge into…", next to Edit, requires `asset_models:change`) and from Review
rows. Body:

1. The duplicate being merged (name, asset count) as a read-only line.
2. **Merge into** — `ComboBox` over all other models (same idiom as the asset
   form), preselected when opened from a duplicate group.
3. On selection the dialog calls the dry run and shows a side-by-side table
   (Field | Keep · {target} | {source} | Result) for the spec fields and
   notes, a line "N assets and M stock lines move; K aliases move; alias
   added: …", and the resulting alias chips. Conflicts render as a red list:
   "‘X’ already belongs to Make Model — remove it there first." and disable
   Merge.
4. **Merge** runs the real call. On success: toast "Merged {source} into
   {target}: N assets moved", the list refetches, the target row opens.
   Errors map: `cannot_merge_self`, `alias_conflict`, `asset_model_not_found`
   ("That model was already merged or deleted — refresh."), `forbidden`.

Changing the target clears the plan.

## Feature 2: Review view

### API

`GET /asset-models/review?include_dismissed=false` — `asset_models:view`.

```json
{"imported": [ReviewItem...],
 "duplicates": [[ReviewItem, ReviewItem, ...], ...],
 "dismissed_count": n}
```

`ReviewItem` = `ModelSummary` plus `reason: "imported" | "duplicate"` and
`group_key` (the normalized key that grouped it, null for imported-only).

- **Imported:** models whose `knowledge` starts with `FORCED:` (case-insensitive)
  and `review_dismissed_at` is null. Ordered by make, model.
- **Duplicates:** every non-dismissed model contributes keys:
  `normalize_model_key(f"{make} {model}")` and `normalize_model_key(alias)`
  for each alias. Models sharing at least one key form a group (union of
  key overlaps, so A~B and B~C is one group). Groups of two or more are
  returned, each ordered by asset count desc then name; groups ordered by
  their first member's name. A model can appear in `imported` and in a group.
- `include_dismissed=true` includes dismissed rows in both lists (portal
  "Show dismissed" toggle); `dismissed_count` is always the total dismissed.

`POST /asset-models/{id}/review` — body `{"dismissed": bool}` — `asset_models:change`
and global. Sets or clears `review_dismissed_at`; audit `review.dismiss` /
`review.restore` on the model; no-op returns 200 without audit.

### Page

Makes / Models gets a `segmented` "All | Review" switch in the toolbar
(house idiom, `role="tablist"`), Review showing a count badge
(imported + models in duplicate groups, deduplicated). The list, filters,
columns and god edit stay exactly as they are in All.

Review renders two sections with the eyebrow style used on detail panels:

- **Created by import** — rows: make/model, asset count, the FORCED note
  (first line), actions: Merge into…, Edit, Dismiss.
- **Likely duplicates** — one card per group listing members with asset and
  alias counts and the shared key; per member: Merge into… (preselects the
  other member when the group has two; otherwise the picker is open), Edit,
  Dismiss.
- A "Show dismissed (N)" checkbox reveals dismissed rows with a Restore action
  instead of Dismiss.
- Empty state: "Nothing to review — the catalog has no import-created or
  overlapping models."

Merge and Edit reuse `ModelMergeModal` and `ModelEditModal`; after either
saves, both the review data and the list refetch.

## Out of scope

Spec-completeness check (third to-do item), trigram similarity, merging more
than one duplicate at a time, undo.

## Testing

- API: migration applies; review detection (imported tag, key grouping via
  name and alias, transitive groups, dismissed hidden/shown, counts); dismiss
  and restore with audit; merge dry run (moves, fills incl. unit pairs, alias
  added/skipped, conflicts) writes nothing; real merge moves assets and stock
  lines, moves aliases, adds alias, fills, appends notes, deletes source,
  audits both rows; self-merge 409; conflict 409; 404s; permission gates.
- Portal: `ModelMergeModal` (plan render, conflicts disable Merge, payloads),
  review view (sections, dismiss, show dismissed), lib helpers; whole suite +
  `tsc --noEmit`.
- Live on the branch stack: create a deliberate duplicate in the dev DB, see
  it in Review, merge it with the dialog, confirm the assets moved.
