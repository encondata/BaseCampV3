# Label templates — site scoping and convert-to-code

**Date:** 2026-09-01
**Branch:** `labels` (extends the shipped Labels feature, spec
`2026-09-01-labels-design.md`)
**Status:** Approved design

## Purpose

Two additions to label templates:

1. **Site scoping** — a template can be assigned to one or more sites; the
   Templates list shows the assignment and the editor manages it. A template
   with no sites is **global** (usable everywhere); assigning sites narrows
   it. This is the deliberate replacement for V2's CSV `sites` column.
2. **Convert-to-code** — a builder (design-kind) template can be converted
   in place to a raw-code template so its generated ZPL/Brother code becomes
   hand-editable. One-way: the element model is discarded (hand-edited code
   cannot be decomposed back into draggable elements). Raw editing of
   code-kind templates already exists and is unchanged.

## Part 1 — Site scoping

### Schema (migration 0043)

`label_template_sites`:
- `template_id` UUID NOT NULL, FK → `label_templates.id` ON DELETE CASCADE
- `site_id` UUID NOT NULL, FK → `sites.id` ON DELETE CASCADE
- PRIMARY KEY (`template_id`, `site_id`); index on `site_id`

No changes to `label_templates`. Empty assignment set = global.

### API

- `LabelTemplateOut` gains `site_ids: list[UUID]` (always present, `[]` for
  global), loaded via a `LabelTemplate.sites` relationship (or a grouped
  query on the list endpoint — implementer's choice, one query either way).
- `LabelTemplateCreateIn` / `LabelTemplateUpdateIn` gain
  `site_ids: list[UUID] | None = None`.
  - Create: `None`/absent or `[]` → global; a list creates assignments.
  - Update: absent → assignments untouched; a list **replaces** the full
    set; `[]` clears to global.
  - Any unknown site id → 422 `unknown_site` (with the offending id).
  - An assignment change is a change: version bump + audit (diff of sorted
    id lists under a `site_ids` key).
- `GET /labels/templates?site_id=<uuid>` returns templates assigned to that
  site **plus** global templates (the "usable at this site" query the
  Generate phase reuses). Combines with the existing filters.

### Portal

- **Editor top bar**: a Sites control — chips for each assigned site
  (site name, ✕ to remove) plus a type-to-filter combo to add sites
  (existing ComboBox/tag-input patterns, `.tag-input-*` / `.combo-*`
  styles). Empty state renders a muted "All sites". Site names come from
  the sites lookup the portal already loads elsewhere; fetch once on mount
  alongside vocab. `site_ids` rides the existing save body for both create
  and update.
- **Templates list**: new default column **Sites** — "All sites" (muted)
  when empty, else the first site name plus a `+N` chip when more. A Sites
  facet (options = sites appearing in loaded rows, plus "All sites" for
  globals). CSV export emits semicolon-joined site names.

## Part 2 — Convert-to-code

### API

`POST /labels/templates/{id}/convert-to-code` (gate `labels:change`):
- 404 `unknown_template`; 409 `not_a_design_template` when already
  code-kind.
- Compiles the stored design with the template's own size/dpi/language in
  **placeholders mode** (tokens intact) via the existing compiler dispatch
  (ZPL or Brother — conversion works for any language).
- In one transaction: `kind='code'`, `code=<compiled>`, `design=NULL`,
  `version += 1`, `updated_at` bumped, audit action `convert_to_code`
  (changes: `{"kind": {"from": "design", "to": "code"}}`).
- Returns the updated `LabelTemplateOut`.
- A design that no longer parses (should be impossible — writes validate)
  returns 422 `bad_design` and changes nothing.

### Portal

- **Editor**: on design-kind templates, an "Edit as raw ZPL" button in the
  top bar (label "Edit as raw code" when the language is Brother). Click →
  `window.confirm("One-way: the draggable elements are discarded and this
  becomes a raw-code template. Continue?")` → call the endpoint → switch the
  page in place to the code-kind textarea view seeded with the returned
  `code`. Gated on `can('labels','change')`; disabled while the template has
  unsaved changes is NOT required (the server converts the SAVED design —
  the confirm text notes unsaved canvas edits are not included).
- **Templates list row menu**: same action ("Edit as raw ZPL") on design
  rows, pre-gated on `labels:change`; after confirm + convert it navigates
  to the edit route.

## Error handling summary

- Unknown site id on create/update → 422 `unknown_site`; nothing partial —
  assignment replacement is transactional with the template update.
- Deleting a site cascades its assignments away; a template whose last site
  assignment disappears becomes global (documented behavior, no warning
  needed at this scale).
- Re-converting a code template → 409; the UI never offers the action on
  code rows.

## Testing

- **API**: assignment CRUD (create with sites, replace, clear-to-global,
  absent-leaves-untouched), unknown site 422, version bump + audit on
  assignment change, `?site_id=` filter returns assigned + global rows and
  composes with `label_type=`; convert round-trip (code equals the compile
  endpoint's placeholders-mode output, version bump, audit row), 409 on
  re-convert, tokens preserved in converted code.
- **Portal**: list column renders "All sites" and name-plus-`+N` states;
  editor chips add/remove round-trip into the save body; convert button
  design-kind-only, confirm-gated, flips the view to the textarea.

## Out of scope

- Per-site template resolution/fallback logic at generation time (Generate
  phase; the `?site_id=` filter is its building block).
- Converting code → design (impossible by design).
- Site-scoping vocab or placeholders (templates only).
