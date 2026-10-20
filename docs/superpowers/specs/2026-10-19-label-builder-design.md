# Label builder — design

Date: 2026-10-19. Replaces the label template editor described in
`2026-09-01-labels-design.md` (its model and compiler stay; its UI goes).
Recon behind this document: `docs/superpowers/research/2026-10-19-label-builder-recon.md`.

## 1. Intent

Labels are now generated on the kiosk from stored templates, so the templates
have to be right, and today they aren't: every label in use is hand-written
ZPL carried over from V2, two copies per DPI, with placeholder spellings V3
never understood. The Vegas Destination tag, the hardest label in use, has
never printed correctly from either system.

Jimmy wants a label builder that lets him design a template on screen the
way ZebraDesigner or BarTender would, with the data that matters (asset,
move, site), and have that one design print identically from the portal and
every kiosk, at any printer resolution. His words: "This needs to compete
with industry standard tools like zebra designer or bartender."

**Who uses it.** Jimmy and one counterpart. It is a high-skill tool for super
admins and developers, never shown to workers or lower ranks. That means
dense controls, exact numbers, keyboard shortcuts, and no hand-holding.

## 2. Goals, non-goals, anti-goals

**Goals**
- Design a label visually and see it the way the printer will print it,
  with real sample values.
- One design, every DPI: 203, 300 and 600 generated from the parent.
- Location strings like `14.01.07C.02.03` broken into named pieces
  (NAP, Sector, POD, Row, Rack) by the template, with the names chosen per
  template because they differ between sites.
- Fonts chosen per field from a short, installable list.
- Per-field text rules: expected length, max characters with trim, strip,
  number padding, alignment, bold, inverted.
- Template versions, clone, nested DPI children, safe delete.

**Non-goals**
- Brother printers. The new element properties are Zebra ZPL only; the
  Brother compilers keep ignoring what they can't do.
- Images and logos on labels, and the Asset photo field. Later.
- Barcode symbologies beyond Code 128 and Code 39, and 2D beyond QR.
- Conditional logic beyond "hide when empty".
- Serial counters, date arithmetic, formulas.
- Anything for workers: the builder lives in the portal under Labels and
  is gated to super admin or developer.

**Anti-goals** (what would make it a failure even if it works)
- A label that prints differently on the kiosk than in the portal preview.
- Placeholders that print literally because of a spelling.
- Neighbors that shift when a value is longer or shorter than the sample.
- Hand-doubled coordinates to get a second DPI.

## 3. Jimmy's decisions

These came from the conversation on 2026-10-19 and are binding.

### 3.1 Location strings and Split
- `14.01.07C.02.03` reads NAP 14, Sector 01, POD 07C, Row 02, Rack 03. A
  sixth piece, when present, is RU, "but that usually comes from
  elsewhere". The meanings can differ between clients and sites, so the
  template names the pieces.
- Split is a display type. It breaks the field's value on `.` and adds one
  sub-field under the parent for each piece of the **sample** value. Each
  sub-field gets a name typed by the author and its own settings.

### 3.2 Per-field settings
- Display type: Text, Number, Barcode, QR code, Split.
- Weight: Normal or Bold. Inverted: on or off (a black box around the
  item with white text).
- Expected character length, so a value of 1 or 10 keeps its spacing.
  Number pads with leading zeros to the expected length.
- Max characters, and when on, Trim front or Trim rear.
- Strip: remove a given value (for example `0`) from the front, the rear,
  or anywhere.
- Alignment inside the reserved width is per field.
- Font per field, defaulting to `TT0003M_.TTF`. Only fonts in the font
  library are offered, so a printer can be set up with them. About eight
  options, with a friendly name and a rendered sample in the dropdown.
  The eight: Swiss 721 Condensed Bold (default), Roboto Condensed, Roboto,
  Oswald, Roboto Mono, IBM Plex Mono, Atkinson Hyperlegible, Source Sans 3.
  Roboto Mono and IBM Plex Mono are monospace.

### 3.3 Sample values
- Every field has a sample value, saved with the template. Split uses the
  sample to decide how many pieces exist.

### 3.4 Templates, DPI, versions
- Creating a template creates three children: 203, 300 and 600 DPI.
- The template list is nested: parent, then its children.
- Editing the parent regenerates all children. A child can also be edited
  on its own at its DPI.
- When the parent regenerates and a child has its own edits: keep that
  child and flag it, and ask whether to create an updated one from the
  parent. If yes, the customized child is renamed with "Old" appended and
  stays nested under the parent, inactive; a fresh child takes its place.
- Full create, read, update and delete on every template. Deleting a parent
  requires confirmation by typing its name. Versioning on every template.
  Clone to a new template.
- The DPI column reads "All" when all three children exist.

### 3.5 The screen
- Fields on the left with a search and a **+** that opens a picker. Fields
  already on the label sink to the end of their group in grey with a count;
  duplicates are allowed.
- The table of placed fields sits under the canvas, with the per-field
  controls in columns.
- Grid, snap and rulers; alignment tools for multiple selected fields.
- Keyboard shortcuts as in §6.
- Labels of any size: the preset list plus a custom width and height.

### 3.6 Fields offered
Asset: Asset ID, Name, Serial, RFID tag, Pod number, Status, Has rails,
Location detail. Make & model: Make + Model. On this move: Source rack, RU,
position (Front/Rear), pod; Destination rack, RU, position, pod;
Priority/Wave; Disposition; Owner; Cable info (Data 1–6, Mgmt 1–2); Vendor
involved; Roster status; any column from the uploaded From-To row. Move:
Name, Code (new), Date (short and long). Sites: Origin site name and code,
Destination site name and code. Nothing from trucks, people or the
printing kiosk, and no container data on asset labels.
- **Container-type templates** (Container Label, Container Info) open in
  the builder too (Jimmy, 2026-10-19). For those the field panel shows a
  Container group instead of Asset / Make & model / On this move:
  Container name, Container ID, Label tag, RFID tag, Container type,
  Status, plus the Move and Sites groups. The groups shown follow the
  template's type.

### 3.7 Elsewhere
- The portal's ⌘B sidebar shortcut moves to ⌘\ so ⌘B can mean bold in the
  builder.

## 4. How it works

### 4.1 The template model
- A **template** (the parent) is a design in real units: a size in inches
  and a list of elements with positions and sizes in inches, plus the
  template's sample values and metadata (name, type, size, sites, active).
- Each **DPI child** is a full copy of the design pinned to a DPI, so it can
  be opened and edited alone. Children are generated from the parent on
  every parent save, except children flagged *Customized*, which follow
  §3.4.
- Child versions count under the parent's: `v7.2` is the second hand edit
  on top of parent v7. Every save keeps the previous version; older
  versions can be opened read-only or restored as the next version.
- The kiosk sync and the portal generator pick the child whose DPI matches
  the printer, as they do today for the `- 203DPI` / `- 300DPI` pairs. The
  suffix naming convention retires: a child is identified by its parent and
  its DPI.
- Site links stay on the parent and apply to its children. The template
  pick order (destination, source, global, Generic Rack and RU fallback,
  with DPI fall-through) is unchanged.
- The parent remembers which DPIs it has. "Delete this DPI" removes that
  child from the set; the parent's menu gains **Add DPI** to bring one
  back; "All" in the list means all three are present.
- Only one active template may exist per family, type and DPI. Activating
  a second one is refused; the list offers **Replace…** instead, which
  deactivates the old one and activates the new one in one step. That is
  how the rebuilt templates take over from the old code rows (§4.11).
- **Portal generation runs** (Labels › Generate) choose a DPI in the
  Generate modal (default: the last connected printer's DPI, else 300),
  and generated labels are keyed per DPI as well as per asset and type. The
  Print Labels page shows the rows for the connected printer's DPI.
- **Deleting a template** also deletes the labels generated from it in the
  portal (they are regenerable); the confirmation lists how many. Kiosks
  prune their local copies on their next regeneration.

### 4.2 Elements
Every element has: id, x, y, w, h in inches, rotation (0/90/180/270), a
stacking order, lock, and hide-when-empty (data elements only).

| Element | Properties |
|---|---|
| Field (data) | field key; display type; sub-fields when Split; font; size (pt); weight; inverted + padding; expected length; alignment; max characters + trim; strip; sample value |
| Static text | content; font; size; weight; inverted; alignment |
| Line, Box | stroke width; box: fill |
| Barcode | field or static data; Code 128 or Code 39; bar height from the box; module width; human-readable line on/off |
| QR code | field or static data; size from the box (magnification in printer steps); error correction M |

**Field value pipeline** (in this order): take the raw value → Split (if the
display type is Split: the piece for this sub-field) → Strip → Max
characters with trim → Number padding to the expected length → placed
inside the reserved width with the chosen alignment. Hide-when-empty
checks the value after Strip and trim. Number padding pads the integer
part only, so `3.5` with expected length 2 prints `03.5`. The RU fields
are bare numbers (`13`, `3.5`); a `U` is a caption the author places. The
existing catalog keys keep their `U13` form for code templates.

**Expected length and the reserved width.** For Text, the reserved width is
N × the widest glyph of the chosen font at the chosen size; for Number, N ×
the digit width; for a monospace font, N × the cell width. The canvas draws
the reserved box, not the sample's extent. Neighbors never move. A
left-aligned field compiles to a plain `^FT` at the box's left edge; a
centered or right-aligned field compiles to a one-line `^FB` over the
reserved width with that justification, since the printed value differs
per asset and only the printer knows its width. A value wider than the box
spills to the right (left-aligned) or overprints its own line (centered
or right-aligned), and the canvas shows the spill in red past the box so
the author sets Max characters. Multi-line static text also uses `^FB`.

**Bold.** When the chosen family has a Bold file in the library, Bold uses
it. When it doesn't (Swiss 721 Condensed Bold has only the one cut), Bold
overprints the text one dot to the right, except on an inverted element,
where two reversed passes would cancel each other: there Bold widens the
glyphs by 15% through the font's width parameter instead. Normal on the
Swiss default is the file as is.

**Inverted.** A filled black box around the element's reserved box plus a
padding (default: a quarter of the font size horizontally, a tenth
vertically, editable per element in dots), with the text printed in
reverse. A blank value prints nothing, no box.

**Resizing.** For text elements, dragging the box height scales the font
size and the width follows the expected length (or is free when no length
is set). For barcodes, height sets the bar height and width snaps to whole
module widths. For QR codes, the box snaps to magnification steps. Line and
box resize freely.

**QR codes at 600 DPI.** Zebra caps QR magnification at 10 dots per module,
so a QR wider than about 0.35 in cannot be reproduced at 600 DPI. The
parent view warns on such a QR element, and the 600 child prints it at the
cap, centered where the parent put it.

**Positions.** The browser computes each text element's baseline from the
font's metrics and stores it with the element; the compiler emits `^FT` at
that baseline, so the printer places the text exactly where the canvas did
and no emulation of the printer's own font layout is needed. Barcodes, QR
codes and shapes use top-left `^FO`.

### 4.3 Split
- Applies to any text field; it breaks on `.` only.
- The sample value decides the number of pieces. Each piece is a sub-field
  with a name the author types, shown nested under the parent in the field
  table and the picker, and placed on the canvas as its own element with
  its own settings.
- A real value with fewer pieces than the sample leaves the missing pieces
  blank; extra pieces are ignored. The parent itself prints the whole
  string if it is placed.
- Pod and RU can come from a piece or from their own fields; the author
  chooses which to place.
- A template has one Split definition per field: the piece names and the
  sample belong to the field. Every placement of a piece is its own element
  with its own formatting, so the Vegas banner and the Vegas grid can both
  show POD, one inverted and one not. The field table has one row per
  placement, grouped under the split parent; `×n` in the field list counts
  placements. Placing the field again as Split reuses the same pieces.

### 4.4 Fonts
- The font library gets a **family** and **weight** on every file, a
  display name, and the 8.3 object name the printer uses. The eight
  families in §3.2 are loaded in Regular and Bold where the family has
  one, all under licenses that allow printer installation and browser
  serving.
- The builder serves the same TTF to the browser, so the canvas renders
  the real glyphs and measures real widths.
- Setup step 5 on a Label Station, and the Printer Setup page, install the
  fonts a template uses, as they do today.
- The dropdown shows each font's name with the sample `0O 1Il 7`, rendered
  in that font.
- **The default is different.** Swiss 721 Condensed Bold is a commercial
  Bitstream cut that Zebra ships on the printer; its file may be installed
  on a printer but not served to browsers. So: the library marks it
  *resident*, step 5 and Printer Setup only check it is present and never
  push it; the canvas draws it with Roboto Condensed Bold as a stand-in
  while reserving widths from the real file's metrics, which the server
  reads once from the library copy. Spacing is exact; the glyph shapes on
  screen are close but not the printer's. The printed preview (Labelary)
  renders the default through Zebra's built-in font 0, which is the same
  face, so that preview is exact for it.

### 4.5 The canvas
- Rulers in dots for the DPI being viewed (the parent shows 300 unless
  switched), grid and snap, zoom to fit, 1:1 (one dot per pixel) and
  steps, pan with space-drag.
- Select, multi-select with ⇧-click or a marquee, eight resize handles, a
  rotation choice, drag with axis lock, Alt-drag duplicate.
- Alignment tools for a selection: left, center, right, top, middle,
  bottom, distribute horizontally and vertically, match width and height.
  With one element selected they align to the label.
- Field names / Sample values toggle. Sample values are the default.
- `/` focuses the field search; ⌘K stays the portal's command palette.
- Every number box accepts arithmetic (`+5`, `*2`) and steps with arrows.
- A dirty indicator and an unsaved-changes guard.

### 4.6 The field panel and the field table
- Left panel: search (⌘K), the **+** picker (static text, line, box, then
  the fields), and the grouped field list with sample values. Unused fields
  first; placed fields last in their group, greyed, with `×n`.
- The sample value of a field is edited in place in the list. **Load from
  asset…** picks a move and an asset and fills every sample from that row.
- The "any column from the uploaded From-To row" fields are listed from
  the union of headers seen across moves, plus a free-text entry for a
  header the picker hasn't seen; their key is `ft:<header>`. Their sample
  comes from Load from asset… or is typed.
- Under the canvas: the table of placed fields with columns Field, Display,
  Font, B, Inv, Expected, Max, Trim, Strip, with Split parents and their
  pieces nested. Selecting a row selects on the canvas and vice versa.
- Right panel: full properties of the selected element; with several
  selected, a change applies to all of them.

### 4.7 Preview and test print
- The canvas is the preview. The existing printer-rendered preview
  (Labelary) stays as a check, with sample values substituted and the
  template's open fonts embedded in the request (cached on the server);
  the resident default renders through Labelary's font 0 (§4.4).
- The Roboto Condensed Bold stand-in for the default font on the canvas is
  Jimmy's choice (2026-10-19) over buying a Swiss 721 webfont license.
- Test print sends the label with sample values to a USB printer from the
  portal, as today.
- **Sample values never leave the portal.** They can hold one client's real
  asset data, and a global template reaches every kiosk, so the kiosk sync
  carries no samples. The Label Station's test label (setup step 5 and
  Printer Setup) renders the template the station's plan actually picks,
  with the fixed mock values the portal already uses, through the portal's
  test-render route.

### 4.8 Compiling and printing
- The design compiles to ZPL in the shared Python label code
  (`serversherpa.labels`) that the portal and the laptop edge already share,
  so a kiosk prints the same bytes the portal would.
- New ZPL the compiler emits: `^A@` with the font's object name, the bold
  overprint, `^GB` fills with `^FR` for inverted, `^FB` with justification
  for alignment inside the reserved width, per-element QR magnification and
  Code 128 options. Positions stay top-left `^FO`; the browser's font
  metrics decide where text sits, so no printer-side metrics are needed.
- The sync carries the fields in §3.6 (several are new to the sync) and the
  move's new code.
- Every design carries a schema version. A laptop whose edge is older than
  the schema reports `template_unsupported` for that template and prints
  nothing from it, with the reason shown at the station and on the kiosk's
  portal page, which also shows the laptop's version. Nothing degrades
  silently. The operating rule: update the laptops, then Replace the old
  template.
- Nothing label-level is stored in a template: print mode, speed, darkness
  and offsets belong to the station's printer settings.

### 4.9 Templates list
The page stays visible to anyone with `labels:view`, read-only: no row
menus, no New template. Designing, editing, cloning, versions and delete
need super admin (rank 80 and up) or developer.

A tree, as mocked up: parent rows with type, size, DPI ("All" or the ones
present), version, state and sites; child rows with DPI, version and
state chips *From parent*, *Customized*, *Out of date*, *Kept · inactive*
for Old children. Row menus: parent — Edit design, Versions, Clone to new
template, Sites, Deactivate, Delete; child — Edit this DPI only, Update
from parent, Versions, Test print, Delete this DPI. Delete on a parent
lists everything that goes (children and generated labels) and requires
the typed name. Versions show one line per save with what changed, Open
and Restore. The "what changed" line is generated from the design diff
(elements added, removed, moved, settings changed); the author can add a
note to a version afterwards from the Versions panel, so ⌘S never prompts.

### 4.10 Sizes
New template offers the size list (4×2, 4×3, 2×1, 1×1, 4×6, 6×4, badge)
and **Custom…** with width and height in inches or millimeters, which can be
saved to the list.

### 4.11 Migration
- The five stored code templates (Vegas Destination, Amsterdam
  Destination, Generic Rack and RU, Front Asset Tag, Switch Front Tag) are
  rebuilt in the builder as part of this work, under the same family
  names; the Vegas tag is the acceptance test, including a physical print
  on the office ZD421 compared against the canvas. Each rebuilt template
  takes over through **Replace…** (§4.1), so there is never a moment with
  two active templates for one family and DPI, and the old code rows are
  kept inactive.
- The QR on the rebuilt Vegas tag carries the bare asset ID; the `<` in the
  old template was a typo.
- "Edit as raw ZPL" stays as an escape hatch for a code template, but new
  templates are designs.
- Operator steps, once per stack (the rebuilt designs live in
  `serversherpa.labels.builtin_templates`):
  1. `serversherpa seed-label-fonts`.
  2. `serversherpa seed-label-templates`. The five parents and their 203,
     300 and 600 DPI children land inactive, linked to no site. An old
     code row that holds one of the names is renamed "<name> Old" first
     (the command lists each rename); running it again changes nothing.
  3. Open each parent in the builder and check it against the old tag.
  4. Print the Vegas tag on the office ZD421 and compare it with the
     canvas.
  5. Per family, Replace… the old code rows with the rebuilt parent, then
     link its sites (the old rows keep theirs).

## 5. Keyboard shortcuts

⌘ on Mac, Ctrl on Windows. Tools: V select, T text, K barcode, Q QR, R box,
L line, Esc back to select. Move and size: arrows 1 dot, ⇧ 10; ⌥+arrows
resize by 1, ⇧⌥ by 10; ⇧-drag locks an axis; ⇧-resize keeps proportions;
⌥-drag duplicates. Edit: ⌘Z / ⌘⇧Z, ⌘C ⌘V ⌘X, ⌘D, Delete, ⌘A, Tab / ⇧Tab
through elements, Enter opens a text element's content, ⌘[ ⌘] back and
forward, ⌘⇧[ ⌘⇧] to back and front, ⌘L lock. Format: ⌘B bold, ⌘⇧I inverted.
Align: ⌥A/D/W/S edges, ⌥H/V centers, ⇧⌥H/V distribute. Canvas: ⌘= ⌘- zoom,
⌘0 fit, ⌘1 true size, space-drag pan, ⌘' grid, ⌘⇧' snap, ⌘R rulers, ⌘E
field names / sample values. Workflow: ⌘S save, ⌘P test print, ⌘K field
search, ⌘/ shortcut sheet.

## 6. Constraints
- Byte-identical output between the portal and the kiosk, through the
  shared Python compiler; a fixture test renders the rebuilt Vegas tag both
  ways.
- Every font offered must be installable on a Zebra printer (TrueType,
  8.3 object name) and licensed for that and for browser serving.
- Existing active templates keep printing until their rebuilt replacements
  are activated.
- American English in all copy. Modals use the report-generate header,
  size to content, rounded corners.
- The kiosk never receives anything but finished ZPL for printing.

## 7. Calls I made (check these while reading)
1. The value pipeline order: Split → Strip → Max/Trim → Number padding →
   alignment.
2. Bold on a family with no bold file overprints by one dot.
3. Inverted padding defaults and that a blank value prints no box.
4. Split pieces missing from a real value print blank; extra pieces are
   ignored; the parent prints the whole string when placed.
5. Resize semantics per element type (§4.2).
6. Barcodes: Code 128 and Code 39 only; QR error correction M; no images
   in this round, so the Asset photo field is dropped for now.
7. Nothing label-level in a template (print mode, speed, darkness).
8. Positions compile to top-left `^FO`; font metrics live in the browser.
9. Child versions numbered under the parent's (`v7.2`).
10. "Load from asset…" to fill samples from a real roster row.
11. The five code templates are rebuilt in the builder as part of the
    build, Vegas first, as the acceptance test.
12. The builder is gated to super admin or developer; the list stays
    readable with `labels:view`.
13. The Brother compilers ignore the new properties rather than refuse the
    template.
14. Portal generation runs choose a DPI; generated labels are keyed per
    DPI; deleting a template deletes its generated labels (counted in the
    confirmation).
15. One Split definition per field per template; placements carry their
    own formatting.
16. Text compiles to `^FT` at a baseline the browser computed; `^FB` only
    for centered or right-aligned fields; overflow shows red on the canvas.
17. The Swiss default is *resident*: never pushed to a printer, drawn on
    the canvas with a stand-in over the real metrics.
18. Bold on an inverted element of a single-cut family widens by 15%
    instead of overprinting.
19. RU fields are bare numbers; padding pads the integer part.
20. Samples never reach kiosks; the station test label is the plan's
    template with the portal's mock values.
21. A design carries a schema version; an older laptop fails visibly.
22. One active template per family, type and DPI; Replace… swaps.
23. The parent remembers its DPI set; Add DPI restores a deleted child.
24. Version lines are generated from the diff, with an optional note after.
25. `/` is field search; ⌘K stays the command palette.
26. From-To columns come from the union of headers across moves plus a
    typed header.
27. QR at 600 DPI prints at the magnification cap with a warning.

## 8. Left to the builder
- The Design JSON extension (a schema version bump) and the migration of
  existing design rows.
- How child designs are stored (a column on the parent's row vs their own
  rows) and how versions are stored.
- The exact canvas rendering and measurement code, and the ZPL for the
  bold overprint and the inverted box.
- The kiosk sync shape for the new fields and the move code.
- The eight font files' sourcing and 8.3 names.
- Test-print plumbing from the builder.
