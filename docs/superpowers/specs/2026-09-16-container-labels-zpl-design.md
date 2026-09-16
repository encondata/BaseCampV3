# Container labels as ZPL — design

**Date:** 2026-09-16
**Branch:** `container-labels-zpl`, off `main` @ `046fc5e` (migration head `0065`)
**Related:** `2026-09-12-container-labels-design.md` (the Avery/jsPDF path this
complements), `2026-09-11-generate-labels-design.md` (the label worker),
`2026-09-12-print-labels-design.md` (the WebUSB print path)

## Problem

Container labels today exist only as an Avery 5164 PDF — an exact port of V2's
jsPDF routine, six labels to a letter sheet (five barcode labels + one info
label per container). There is no way to print a container label on a Zebra.
The Container Labels feature's own follow-up list already named this: "ZPL
container labels through the label worker (vocab type exists)."

Jimmy's ask: a ZPL template targeting a 4" x 6" label, in a 203 dpi and a
300 dpi version, accepting that color is lost.

## Deliberate non-goals

- The Avery PDF path is untouched. It remains the way to get sheet labels, and
  its exactness test against V2 keeps passing unchanged.
- No image/logo element in the label element model. The tag banner is rebuilt
  from primitives instead (see "Tag bar" below).
- No Brother (ESC/P, P-touch) versions of these two templates. They are
  Zebra-only; the Brother compilers simply ignore the Zebra-only properties.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| What is one 4x6 label? | **Two templates**: `container` (tag bar + barcode + name) printed x5, and `container_info` (QR + Source/Dest/Date + RFID zone) printed x1 — mirroring the sheet, so every visible crate face still gets a sticker. |
| How far does it go? | **Full pipeline**: containers become first-class in the label worker and on the Print Labels page, not just seeded templates. |
| How is the tag shown? | **Solid bar with knockout text** — closest to V2's colored banner and the most readable across a room. |
| Untagged containers? | `{label_tag}` **falls back to the word `CONTAINER`**, so the bar is never blank. |
| Per-container quantity? | **`default_copies` in the type's vocab meta** (5 / 1), seeding the print page's existing copies setting, still editable per print. |
| Long container names? | **Sized for ~20 characters with 2-line wrap.** A ZPL `^FB` block only breaks on spaces, so a hyphenated name like `scan-verify-crate` must fit on one line — hence sizing first, wrapping second. |

Three further decisions made while writing this up, flagged for review:

1. **`move_date_long`, a new placeholder.** The existing `move_date` renders
   `%m/%d/%Y`. Jimmy deliberately moved the PDF's date to `dd-MMM-yyyy`
   (`01-SEP-2026`) because `mm/dd` reads ambiguously across the regions the
   company operates in. The ZPL info label should match the PDF rather than
   silently reintroduce that ambiguity. A new key leaves `move_date` untouched
   for the shipped asset templates.
2. **`module_in` absent keeps `^BY2` literally**, so no shipped template's
   output changes by a byte (see "Barcode module width").
3. **Barcode and QR both encode `{container_name}`**, exactly as the PDF does.

## Addendum 2026-09-16 — the move-date off-by-one

Writing the plan surfaced a correctness bug in the existing pipeline, and
Jimmy chose to fix it as part of this work rather than carry it forward.

`initiatives.scheduled_start` is `TIMESTAMP(timezone=True)` holding **midnight
UTC** for what is semantically a date-only field. Both existing formatters
convert it into a local zone before reading the day:

- `values.py`'s `move_date`: `scheduled_start.astimezone(report_timezone()).strftime("%m/%d/%Y")`
- `containerLabelSheet.ts`'s `formatLabelDate`: `new Date(iso)` then `getDate()`,
  with the worker's `TZ` set to the company zone

Anywhere west of UTC that names **the day before** the scheduled date. A move
scheduled 2026-09-15 prints `09/14/2026`. This is the same class of bug found on
the initiatives timeline on 2026-09-15, where the bar drew Sep 7 -> Sep 25 while
its tooltip read Sep 6 -> Sep 24. The existing tests missed it because they feed
noon timestamps (`2026-09-01T12:00:00`), which survive the shift.

**Decision: fix all three.** `move_date` and `formatLabelDate` are corrected to
read the Y-M-D digits as stored, and the new `move_date_long` is written correctly
from the start. Regression tests pin a west-of-UTC zone and a midnight-UTC input.

The Avery PDF's V2 exactness test needs **no** expected-value churn: its embedded
copy of V2's routine calls the same `formatLabelDate`, so both sides of the
comparison move together and log-equivalence still holds.

## Fidelity losses versus the PDF

Beyond color, which Jimmy already accepted:

- **Dashed rules become solid.** ZPL `^GB` has no dashed stroke, so the RFID
  zone's two dashed lines print solid.
- **No per-name font shrinking.** The PDF shrinks the name from 42pt down until
  it fits; ZPL cannot measure text, so the template uses a fixed size chosen to
  fit ~20 characters, with a 2-line wrap for names containing spaces.
- **The tag bar is always present.** A static template cannot omit an element,
  so an untagged container prints a `CONTAINER` bar where the PDF printed
  nothing.

## 1. Vocab and seed data — migration `0066`

| Addition | Value |
|---|---|
| `size` row `4x6` | `{"width_in": 4, "height_in": 6, "has_tab": false}` |
| `type` row `container_info` | "Container Info Label" |
| `type` meta | `container` -> `{"default_copies": 5}`, `container_info` -> `{"default_copies": 1}` |
| placeholder scope | add `container`,`container_info` to `source_site`, `destination_site`; add `container_info` to `container_name`, `container_id`, `move_name` |
| new placeholder `label_tag` | `applies_to` `{container,container_info}`, sample `Priority` |
| new placeholder `move_date_long` | all types, sample `01-SEP-2026` |
| 4 template rows | Container Label 203 / 300 and Container Info 203 / 300 — `kind='design'`, each pair sharing one design JSON, differing only in `dpi_key` |

The existing `size` row `6x4` is 6" wide x 4" tall (landscape); `4x6` is the
portrait orientation a 4" roll actually feeds, so it is a new row, not a rename.

## 2. Element model — three additive properties

All three are backward-compatible: absent means exactly today's output.

- **`TextEl.reverse: bool`** -> emits `^FR` before `^FD`. Drives the knockout
  text on the tag bar.
- **`TextEl.lines: int = 1`** -> `^FB{w},{lines},0,{just},0`. This also fixes a
  latent quirk: `^FB` is currently emitted only when `align != "left"`, so a
  left-aligned field cannot wrap at all today.
- **`BarcodeEl.module_in: float | None`** -> `^BY{dots}`. **Absent keeps the
  literal `^BY2`.**

### Barcode module width

`_barcode()` in `labels/zpl.py` hardcodes `^BY2` — two dots per narrow module.
Two dots is 0.0099" at 203 dpi but 0.0067" at 300 dpi, so **the same design
compiled at the two dpi produces physically different barcode widths**, and the
300 dpi module falls below the 0.0075" minimum generally recommended for
reliable scanning. A dpi-portable template cannot rely on it.

Making `^BY` scale with dpi unconditionally would widen every existing 300 dpi
template's barcode by 1.5x and risk overflowing labels already in use. So the
module width becomes an optional per-element property in inches: the container
templates set `module_in: 0.01` (2 dots at 203, 3 at 300 — same physical width,
both above the scan minimum), and every existing template, having no
`module_in`, compiles byte-identically to what it does today.

### Brother compilers

`brother_escp.py` and `brother_ptouch.py` ignore `reverse` and `module_in` and
honor `lines`, documented inline. These two templates are Zebra-only.

## 3. The two designs — 4" x 6"

```
CONTAINER LABEL  (x5)                 CONTAINER INFO  (x1)
+--------------------------+          +--------------------------+
|##########################|          | Source:        +------+  |
|######  PRIORITY  ########|          |   NAP7         |  QR  |  |
|##########################|          | Dest:          +------+  |
|                          |          |   NAP11                  |
|  ||| |||| || ||| |||| |  |          | Date:                    |
|  ||| |||| || ||| |||| |  |          |   01-SEP-2026            |
|                          |          | Container:               |
|        CRATE-17          |          |   crate-17               |
|                          |          |                          |
|                          |          | ________________________ |
|    NAP11 Migration       |          |      RFID TAG HERE       |
+--------------------------+          | ________________________ |
                                      +--------------------------+
```

**Container label** elements, top to bottom: the tag bar (a `box` whose
`strokeIn` equals its height, which already compiles to a solid `^GB w,h,h`,
plus a centered `reverse` text element bound to `{label_tag}`); a `code128`
barcode of `{container_name}` with `module_in: 0.01` and `showText: false`; the
container name, bold and centered, `lines: 2`; and `{move_name}` small at the
foot.

**Container info** elements: a QR of `{container_name}` top-right; the four
bold-label / indented-value pairs Source / Dest / Date / Container, bound to
`{source_site}`, `{destination_site}`, `{move_date_long}`, `{container_name}`;
and the RFID zone — two solid rules with `RFID TAG HERE` centered between them.

### Provisional geometry

Starting values, in inches on a 4 x 6 canvas. These are a starting point, not a
contract: they will be tuned against real Labelary renders at both dpi during
implementation rather than trusted from arithmetic, and the 28pt name size in
particular is an estimate until a render confirms it fits ~20 characters.

| Element | x | y | w | h | Notes |
|---|---|---|---|---|---|
| Tag bar (box) | 0.20 | 0.30 | 3.60 | 0.80 | `strokeIn: 0.80` -> solid |
| Tag text | 0.20 | 0.52 | 3.60 | 0.36 | 26pt bold, center, `reverse: true` |
| Barcode | 0.80 | 1.60 | 2.40 | 1.20 | code128, `module_in: 0.01`, `showText: false` |
| Name | 0.20 | 3.10 | 3.60 | 1.00 | 28pt bold, center, `lines: 2` |
| Move name | 0.20 | 5.55 | 3.60 | 0.20 | 10pt, center |

The info label uses the same 0.20 side margin, a 1.20 QR at the top right, the
four label/value pairs down the left at 14pt bold / 14pt normal, and the RFID
zone as two 0.01 rules 0.55 apart at the foot.

### Resolved details

- **`container_id`** resolves to `str(container.legacy_id)` when set, else `""` —
  the same treatment `asset_id` gives `Asset.legacy_id`, and what the `C-0017`
  sample in the seeded placeholder already implies.
- **The container roster** for a run is every `Container` with
  `initiative_id == run.initiative_id` **and `archived_at IS NULL`**. Excluding
  archived containers deliberately closes, for the ZPL path, the "archived
  containers are still labelable" wart left open by the PDF path.
- **Template site scoping needs no change.** The runner already resolves
  `template_site_id = initiative.destination_site_id or initiative.origin_site_id`
  once per run and hands it to `select_template`; container types use the same
  value, so site-linked container templates work exactly like asset ones.

## 4. Generation pipeline — containers as first-class entities

The largest piece of work. Today `runner.py` hardcodes `entity_type="asset"`,
`_load_roster` returns `AssetRow`, and `values.py` carries an explicit comment
that containers are out of scope, resolving `container_name`/`container_id` to
`""` for every asset row.

- **`values.py`**: add a `ContainerRow` and `container_placeholder_values(...)`
  alongside the asset path, including the `CONTAINER` fallback for an untagged
  container and the `move_date_long` formatting.
- **One `ENTITY_FOR_TYPE` map** (`container`/`container_info` -> `"container"`,
  everything else -> `"asset"`), living beside the existing `labels/tags.py`
  key source so exactly one place knows this.
- **`runner.py`**: roster loading becomes per-label-type, and `total` becomes a
  sum over types rather than `len(roster) * len(label_types)` — with mixed
  entity kinds the rosters differ in length.
- **Generate Labels page and run preview**: container types selectable, with
  counts drawn from containers.

`GeneratedLabel` already carries `entity_type` and its upsert already keys on
`(entity_type, entity_id, initiative_id, label_type)`, so no schema change is
needed for the rows themselves.

## 5. Print page

`GET /labels/generated/bundle` already filters by `label_type`, so the bundle
works as soon as container rows exist. `PrintAssetList` is asset-shaped (rack /
RU sort, rack separators), so containers get a sibling list rather than a
contorted shared one; it lists the containers that have a generated label of the
selected type on the selected initiative, with the same checkbox column, search,
column menu and Ready/Missing filter, sorted by container name. The copies
setting seeds from the selected type's `default_copies` meta and remains
editable.

## 6. Testing

Alongside the usual unit coverage of the new model properties, the runner's
container path, and the bundle endpoint, two tests carry specific weight:

- **Physical-size invariance.** Compile each seeded design at 203 and at 300 and
  assert every emitted dot coordinate maps back to the same inch position within
  rounding. This is the test that would have caught the `^BY2` problem, and it
  is the entire point of shipping "a 203 and a 300 version".
- **Backward compatibility.** The existing seeded templates compile
  byte-identically before and after the element-model changes.

Visual verification uses Labelary: `POST /labels/preview/zpl` and
`labels/labelary.py` already exist, so all four templates can be rendered and
inspected rather than reasoned about.

## Suggested phasing

The work is one coherent feature but splits cleanly if it needs to land in
stages. Section 4 (the worker's roster generalization) is the large piece; the
natural cut is to do sections 1-3 plus 6 first — the migration, the element-model
properties, the seeded templates and their tests, all verifiable through the
template editor and Labelary without any worker change — and then sections 4-5
as a second pass. This ordering is a suggestion for the plan, not a requirement.

## Known gotchas carried forward

- `npm install` inside a worktree replaces the `node_modules` symlink with a
  real copy; the main checkout then lacks any new dep until it installs too.
- Worktree API tests need `PYTHONPATH=<worktree>/api/src` — the main venv's
  editable install points at main's `src`, giving false greens otherwise.
- Pinned alembic-head assertions break on every new migration; assert a single
  head instead of a specific revision.
