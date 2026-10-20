# Label Station: label generation, Printing Station, Printer Setup — design

Date: 2026-10-19. This is phases 2 and 3 of
`2026-10-19-label-station-printing-design.md` (setup steps 4–5, merged to
main 65596f22). It also builds on the DPI families (c433f56a) and the
peeler support (6c9744f5).

## 1. Intent

A laptop kiosk set up as a **Label Station** should print an asset's label
the moment the asset is scanned. It prints on the printer chosen in Kiosk
Setup, with that setup's offsets and peel mode. Jimmy's goals, from the
phase 1 design:
- Every label the move needs is generated before anyone prints.
- Only finished ZPL is ever sent to a printer.
- Labels come out the same as the portal would make them.
- Setup and troubleshooting have to be perfect: clear wording, every
  failure says what to do, and checks are pinned to real printer replies.

## 2. Scope

**In this round:**
1. **Label generation on the laptop (phase 2):** generate and store every
   label for the move, regenerate when data changes, and show the yellow
   regeneration screen.
2. **Printing Station (`/labels/station`, phase 3):** scan an asset and its
   label prints.
3. **Printer Setup / Troubleshooting (`/labels/printers`):** use the
   station's saved printer (USB or network) and its offsets.
4. **Home tiles:** an RFID Station laptop no longer shows Label Printing.

**Not in this round:**
- **Bulk Print** (`/labels/bulk`). Jimmy: "lets hold off on bulk printing
  for now". It stays a placeholder.
- **The web kiosk's /labels pages.** They stay exactly as they are today:
  USB-only Printer tools, with Printing Station and Bulk Print as
  placeholders.
- **Android and iOS.**

## 3. Jimmy's decisions (2026-10-19)

- **Template per asset.** Jimmy confirmed this order ("that order is
  right"):
  - **Top label:**
    1. the Top template linked to the move's **destination** site;
    2. else one linked to the **source** site;
    3. else a **global** Top template (one with no site links);
    4. else **Generic Rack and RU**.
  - **Front label:**
    1. a Front template linked to the **destination** site;
    2. else the **global** Front template.

  Within the chosen template, the **DPI version** whose `dpi_key` matches
  the printer is used. DPI versions share a family name, e.g. "Generic
  Rack and RU - 203DPI" and "- 300DPI" (c433f56a).
- **A step with no version at the printer's DPI falls through** (Jimmy:
  "1 a"). If the destination's template exists only at 300 DPI and the
  printer is 203, the next step in the order that has a 203 version
  wins: source site, then global, then Generic Rack and RU. Setup step 5
  and the Printer Setup page warn when a site's own template was skipped
  for DPI. That warning never blocks setup *(my call)*.
- **Ties within a step** (two families linked to the destination, or
  several global templates) break the way the portal does: highest
  `version`, then newest `updated_at` *(my call)*.
- **Regeneration is targeted** (Jimmy accepted my recommendation):
  - only changes to data that **appears on a label** count: placeholder
    inputs such as names, serials, racks, RU, pods, sites and move date,
    plus the templates themselves;
  - status changes, including the station's own Labeled scans, never
    count;
  - only the affected labels are rebuilt. A template change rebuilds
    every asset that uses it, and a DPI or label-kind change rebuilds
    everything;
  - the yellow screen shows only while a rebuild is actually running.
- **Labeled scans upload the way RFID scans do** (Jimmy: "treat the
  update back to the api the same as the rfid scans where we retry"):
  - each one is queued on the laptop and uploaded to the portal in
    batches with the same retry schedule as `pending_rfid_scans`: 5 tries
    with growing gaps, then every 30 minutes while the portal answers,
    otherwise waiting for the internet to come back;
  - the portal records them as kiosk scans and runs the status rules, as
    it does for RFID scans;
  - **when one is queued** *(my recommendation, not contradicted)*: once
    the label is sent successfully, including on a repeat scan. The
    **Reprint** button and a **Retry** after a printer error don't queue
    another one, and a failed print queues nothing.
- **Repeat scans print again.** Scanning an asset that already has a
  Labeled scan prints again, with **no warning about duplicate printing**.
- **RFID Station laptops** "will never be used as label stations".
- **Bulk Print is on hold.**
- **Earlier decisions that still stand:**
  - full pre-generation by a standalone script on the laptop;
  - offsets are applied when a label is sent, never baked into the stored
    label;
  - a yellow full-screen alert, "Label regeneration in progress — updates
    were detected", is shown while regenerating;
  - a Label Station records the **Labeled** scan type;
  - only finished ZPL goes to the printer;
  - peel or tear mode is applied per label (`withPrintMode`).

## 4. Label generation (laptop)

- **What is generated:** for every asset on the station's move, **one
  label** of the station's kind (Top or Front), at the printer's DPI, using
  the template order in §3.
- **When it runs:**
  - right after setup step 5 finishes. The printer and its DPI are known by
    then. On the laptop this is Kiosk Setup's final step;
  - after a sync that changes label inputs for some assets, or their
    templates. Only those labels are rebuilt (§3);
  - when the station's printer is changed to one with a different DPI;
  - when the station's label kind changes (Kiosk Setup step 4).
- **What does not trigger it:** offsets and peel mode. Both are applied
  when a label is sent.
- **Same output as the portal.** A label must match what the portal's
  generator would produce for the same asset, template and DPI, **byte for
  byte**.
  - The portal path is `labels/generate/values.placeholder_values` →
    `engine.render_label`.
  - The laptop has to use **the same code**: shared Python, not a copy. It
    covers the placeholder values (including generation rules: position
    splits and length limits), design compilation with values substituted,
    and code templates' placeholder fill.
  - A test renders the same fixtures through both paths and compares the
    bytes.
  - This settles the phase 1 must-fix (`^FH` hex escaping and the P-touch
    `^DI` length): compile the design *with* values, never fill a
    token-intact compiled design.
- **Where it's stored:** on the laptop (the edge's SQLite), one row per
  asset with:
  - the finished ZPL;
  - label kind;
  - DPI;
  - template id, version and name;
  - a fingerprint of the asset data that went into it;
  - generated-at;
  - an error when the label couldn't be made (no template for this asset
    at this DPI, a template that didn't compile, or missing fonts). In that
    case the row has no ZPL and keeps the reason.
- **Regeneration screen.**
  - While a generation run is in progress, every page of the Label Station
    shows a **yellow full-screen takeover**: "Label regeneration in progress
    — updates were detected".
  - It shows progress (n of N) and clears itself when the run finishes.
  - It is styled like the off-move alarm, but yellow. There is no dismiss:
    printing waits.
  - The first generation after setup shows the same screen, with wording
    that says labels are being prepared rather than that updates were
    detected *(my call)*.
- **When a run fails part-way,** for example because the laptop restarted:
  the next start sees the run wasn't finished and finishes it *(my
  call)*. Each label row is replaced only when its new version is ready,
  so a crash never leaves an asset without its last good label.

## 5. Printing Station (`/labels/station`)

**Shown on:** a Label Station laptop only. Its Home has Kiosk Setup,
Label Printing and Settings, and Label Printing opens the launcher as
today.

**The flow:**
1. **Scan.** A worker scans an asset's barcode (asset ID or serial). No
   button needs to be pressed first, the same as the Scanning page's
   input.
2. **Look up.** The kiosk finds the asset in the station's move and its
   stored label.
3. **Print.** The label goes to the printer saved in setup:
   - over USB through WebUSB, or over the network through the edge;
   - with the saved offsets (`applyPrintSettings`, `^LS`/`^LT`) and the
     saved peel or tear mode (`withPrintMode`).
4. **Peel mode.** After sending, the kiosk waits until the printed label
   is taken before sending the next one, polling `~HS` for "labels
   waiting to be taken" *(my call on the method)*. It shows "Take the
   label".
5. **Record.** Once the label is sent, a **Labeled** scan is queued on
   the laptop and uploaded with retries, like RFID scans (§3).
6. **Show the result.**
   - The asset: name, make/model, serial, and source and destination
     rack/RU.
   - A large "Printed" confirmation and a **Reprint** button.
   - A running list of this session's prints, newest first.
7. **Repeat scans** just print again (§3).

**Problems, each with a clear message, where nothing prints:**
- the asset isn't on the move;
- the asset has no generated label, with the stored reason;
- generation is running (the yellow screen covers this anyway);
- the printer doesn't answer, or reports paper out, head open or paused.
  The message says what to fix and offers a **Retry** that resends the
  same label.

**Scans in a row.** Scans that arrive while a label is printing or waiting
to be taken are queued in order and printed one after another *(my call)*.

## 6. Printer Setup / Troubleshooting (`/labels/printers`) on a Label Station

On a Label Station laptop the page works with the **station's saved
printer** instead of only a WebUSB printer. Elsewhere it is unchanged.

- **The printer card** opens on the saved printer, USB or network, already
  connected. It shows:
  - model, firmware and DPI;
  - health chips (paper, head, pause);
  - Peeler (detected or not, so peel-off or tear-off mode);
  - the saved offsets.
- **Test Label Alignment** prints with the saved offsets and peel mode.
  Changing offsets there saves them to the **station's settings**: the
  edge's `label_station`, mirrored to the portal config. The Printing
  Station uses them from the next label on.
- **Full Printer Setup** and **Factory Reset** work for a network printer
  too, sending their commands through the edge.
  - Any extra printer **queries** they need, such as `^HH`, are added to
    the edge allowlist **exactly**, as read-only queries.
  - The edge's raw send already carries ZPL.
  - Each new query gets a test pinned to a real printer's reply. The
    office ZT220 and ZD421 replies are in hand.
- **Change printer** opens the same choices and checks as setup step 5:
  USB, or network with an automatic scan plus a typed IP; answers, DPI,
  status, fonts and peeler.
  - Saving a printer with a different DPI starts regeneration (§4).
- **Install Fonts** installs the fonts the move's templates need, as step 5
  does (move-scoped kiosk font route), instead of "Managed from the
  portal".

## 7. Home tiles

An **RFID Station** laptop's Home drops Label Printing. Its tiles are RFID
Reader, Kiosk Setup and Settings, which matches today's list
(`STATION_TILES.rfid`). The `/labels` routes on an RFID Station redirect
to Home *(my call)*.

## 8. Constraints

- **Printer writes:**
  - never write printer settings on the user's behalf outside the
    explicit tools (Full Printer Setup, Factory Reset);
  - print mode stays per label;
  - nothing runs `^JUS` or `setvar` behind the user's back.
- **Edge printer guard:** RFC 1918 addresses only; it refuses the laptop's
  own addresses and Docker paths and fails closed; the query allowlist
  matches exactly. Unchanged.
- **Copy:** American English. Kiosk idioms (setup cards, `CheckList`,
  `mini-btn`). Modals use the report-generate header pattern, size to
  their content and have rounded corners.
- **Saved station settings:** old settings without new keys keep working.
- **Real printer replies:** every printer reply parser is tested against
  replies captured from a real printer.

## 9. Left to the builder

- **How the shared label code reaches the edge:**
  - The edge is a separate package and image and can't import the API
    today.
  - The design compile chain (`labels/model`, `compile`, `zpl`, `tokens`)
    has no database dependencies. But `generate/values.py` imports the
    `Initiative` and `Site` ORM models, and `generate/engine.render_label`
    takes a `LabelTemplate` ORM object. Sharing them needs a small
    refactor to plain inputs, with the portal's generator moved onto it
    so it stays one path.
  - Choose a way to make one source serve both (a shared package, or
    bundling the module into the edge image). The byte-equality test is
    the guard.
- **What the template sync sends:** today the kiosk gets design templates
  compiled with their tokens left in. Generation needs whatever lets the
  edge compile a design *with* values, which is probably the design JSON.
  Extend `/kiosk/sync/label-templates` as needed, keeping old fields for
  old kiosks.
- **Asset data:** check that the move sync carries every placeholder the
  catalog defines, and add any that are missing. Roster fields were added
  in 8b4abbf5.
- **The template sync:** it must now say whether each template is global
  (no site links) or linked to the move's destination or source site. It
  must also send the global Top and Front templates that the selection
  order needs. Today `move_template_set` only sends global Top templates
  named "generic", and drops the Generic Rack and RU fallback when the
  destination has a linked template. Both still have to come down,
  because the DPI fall-through can reach them.
- **Step 5's DPI check:** it should test the templates the selection order
  actually picks, not merely that some template of the kind exists at the
  printer's DPI.
- **The station key:** the RFID upload path uses a station key that today
  requires a registered RFID laptop. Extend that, or an equivalent, to
  Label Stations so Labeled scans upload without anyone signed in.
- The storage schema, the run bookkeeping, the edge routes and the exact
  copy.
