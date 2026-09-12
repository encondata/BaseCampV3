# Bulk new containers — `/logistics/containers`

**Date:** 2026-09-12 · **Status:** approved by standing instruction · **Branch:** `bulk-containers`

## Purpose

Jimmy: "add a bulk new container option to the /logistics/containers page. It should prompt for count, type, naming convention and then a count for each of the available tag types with + and − buttons. It will then create the number of containers with the label tags if needed. We assign tags in order of Priority, Vendor, Accessories, Warehouse and E-Waste."

## API

`POST /containers/bulk` (resource `containers`, action `add`; same authorization as `POST /containers`), body:

```
{
  "count": 15,                        // 1..500
  "container_type": "pallet",         // required; a container_type vocabulary key (422 bad_container_type)
  "naming": { "prefix": "PLT-", "start": 1, "pad": 3, "suffix": "" },   // name = prefix + zero-padded(start + i) + suffix; pad 0..6; prefix/suffix ≤ 40 chars, prefix or suffix may be empty but not both when pad is 0? — no: only requirement is the resulting names are non-empty
  "initiative_id": null,              // optional (404 initiative_not_found)
  "site_id": null,                    // optional (404 site_not_found)
  "status": null,                     // optional container status key; default = the model default ("available")
  "tags": { "priority": 1, "vendor": 2, "accessories": 0, "warehouse": 0, "ewaste": 0 }   // each ≥ 0; sum ≤ count (422 tags_exceed_count)
}
```

Behavior: generate the `count` names in order; if any name matches an existing non-archived container (CITEXT, case-insensitive) → 422 `name_collision` with `names: [...]` and NO containers created; names within the batch are unique by construction. Create all rows in one transaction with the shared create path (audit rows per container as the single create does, or one bulk audit row carrying the created ids — pick what the containers audit already supports). **Tag assignment order:** containers are created in name order; the first `tags.priority` get `priority`, the next `tags.vendor` get `vendor`, then `accessories`, then `warehouse`, then `ewaste`; the rest have no tag. Response 201: `{ created: ContainerItem[] }` (in creation order). Rate/size: `count` ≤ 500.

## Portal

- `/logistics/containers` header actions gain **"+ Add in bulk"** beside "+ New container" (same permission).
- `BulkContainersModal` (roomy header: eyebrow "Containers", title "Add containers in bulk", description "Create a numbered batch of containers and pre-assign label tags."), two columns:
  - **Left — Batch:** Count (number input 1–500), Type (ComboBox over the container_type vocabulary, required), Naming convention: Prefix, Start number, Zero-pad (segmented 0 / 2 / 3 / 4 digits), Suffix — with a live **Preview** line: first three names … last name ("PLT-001, PLT-002, PLT-003 … PLT-015"); optional Initiative (ComboBox, newest first) and Site (ComboBox); Status left at default.
  - **Right — Label tags:** one row per tag in the order Priority, Vendor, Accessories, Warehouse, E-Waste: colored `chip custom`, a stepper (`mini-btn` "−", the count, `mini-btn` "+"; − disabled at 0, + disabled when the tag total reaches `count`), and a running **summary**: "15 containers · 1 Priority · 2 Vendor · 12 untagged"; when `count` drops below the tag total, the excess is clamped from the last tag backwards and the summary says so.
  - Footer: Cancel / **Create N containers** (disabled until count ≥ 1, type chosen, and names non-empty). On success the modal closes, the list refreshes, and a toast/notice says "Created 15 containers"; on `name_collision` the modal stays open and lists the colliding names under the naming fields; other errors in the `pf-error` strip.
- Pure helpers in `portal/src/lib/bulkContainers.ts`: `buildNames(naming, count)`, `assignTags(count, tags)` (returns the tag per index in the required order), `clampTags(tags, count)`, `summaryText(count, tags)`.

## Testing

- API: names/padding, collision 422 with no rows created, tags sum > count 422, unknown type/initiative/site, tag assignment order (1 priority, 2 vendor → rows 1..3), 201 shape + audit, count bounds.
- Portal: helpers (names, assignment order, clamping, summary), modal (preview updates, steppers disable at bounds and at count, submit payload, collision message, success closes and refreshes), page shows the new action.
