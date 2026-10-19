# Label Station printing — design

Date: 2026-10-19. This builds on the label templates download (main 6f556d79)
and Label Stations recording Labeled (main 71037c01).

## 1. Intent

A Label Station is a kiosk dedicated to printing asset labels for one move.
Jimmy's goals:
- Setup ends with a printer that is **verified ready**: right DPI, fonts
  installed, alignment dialed in.
- Every label the move needs is **already generated** before anyone prints.
- At the door, scanning an asset prints its label instantly.
- **Only finished ZPL is ever sent to a printer.**
- Label generation should look and work the same in the kiosk and the
  portal.

## 2. Jimmy's decisions (2026-10-19)

**Kiosk Setup for a Label Station:** Station type → Move → Site, then:
- **Step 4, "What does this station print?"**
  - **Top labels** come first and are the default. Top labels are 4x2 today; 4x3 is being investigated, so the template's own size decides.
  - **Front labels** are 2x1.
  - The choice changes the whole workflow.
- **Step 5, Printer.**
  - **Laptop kiosk:** a USB printer (WebUSB), or a **network printer found by
    scanning the network**. Network scanning is laptop-only.
  - **Web kiosk:** **does not get a Label Station yet** (Jimmy). It keeps only
    the Label Printing option, which will be worked on later.
  - **Android** (a later phase): USB, or a network printer by **typed-in IP
    address**.
  - **iOS / iPad:** left out for now, because of Zebra SDK distribution limits.
    Show a "not supported yet" placeholder.
- **After choosing a printer, query it for DPI and installed fonts.**
  - Show a **green check** for each item once it's configured and ready.
  - **Missing fonts that the station's templates need are installed right
    there during setup.**
- **Test labels**, in a modal on this step:
  - an **alignment label** at **4x2** or **2x1**: concentric boxes filling the
    whole label;
  - a **Generic Rack and RU** test label with **mock data**.

  After a test prints, the person sets **horizontal and vertical offsets** and
  can retest.
- **Generating labels:** directly after the printer is selected and its DPI is
  verified, **every label the move needs is generated** for the chosen label
  type at that DPI, and **stored ready to print**.
  - **Laptop:** a **standalone script** on the laptop generates them. Jimmy
    chose full pre-generation (option 2) over filling labels in on the kiosk.
    The web kiosk's Label Printing option is a later project.
- **Offsets** are applied when a label is sent, as a standard ZPL position
  command (the same `^LS`/`^LT` shift). Changing offsets never regenerates labels.
- **When data changes after setup**, if a sync brings changes to the move's
  data or its templates:
  - the kiosk shows a **full-screen yellow alert, "Label regeneration in
    progress — updates were detected"**;
  - while it's up, **all labels are regenerated** with the standalone script
    (or the portal, on the web);
  - the alert clears when they're done.
- **Scan to print:** scan an asset, look up its stored label, and send that ZPL
  to the printer with the offsets.

## 3. Phases (my call; each ships on its own)

1. **Setup steps 4–5 (laptop only):**
   - the label type choice;
   - printer selection (USB on both, network scan on the laptop);
   - the DPI and font check, with font install;
   - the test-label modal and offsets.
2. **Generating and storing labels:**
   - the laptop's standalone script;
   - the stored label set;
   - the yellow regeneration alert on data or template changes.
3. **Scan to print.**
4. **Android:** a USB or typed-IP network printer, and its own generator.

This document details phase 1 and fixes the decisions phases 2–4 rely on. Each
later phase gets its own plan.

## 4. Phase 1 in detail

### 4.1 Step 4: label type
- Two choice cards in the existing setup card style: **Top labels** (first,
  pre-selected) and **Front labels**. Each card explains in one line what it
  prints and its usual size.
- Stored with the station's setup as `label_kind: top | front`. On the laptop
  it lives in the edge's shared setup, so every browser on the laptop agrees.

### 4.2 Step 5: printer
- **Two printer types, shown as cards:**
  - **USB:**
    - uses the existing WebUSB hook (`useZebraPrinter`), with Connect opening
      the browser picker;
    - printers the browser already has permission for are offered first.
  - **Network (laptop only):**
    - the laptop's server scans its subnet for port **9100** (the Zebra raw
      port), the same way it scans for RFID readers (`rfid/discovery.py`);
    - a typed IP address is also accepted;
    - the laptop's server sends commands to the printer over port 9100 and
      reads replies.
- **Checks:** after the printer is picked, the kiosk runs these, each shown as
  a row that turns into a green check when it passes:
  - **Printer answers:** host identification, `~HI`.
  - **DPI:** read from `~HI`. The check passes when the printer's DPI matches a
    DPI that the station's templates come in. The 203 and 300 versions were
    downloaded, so either works when both exist.
  - **Status:** `~HS` reports no paper out, no head open and no pause.
  - **Fonts:**
    - list the fonts installed on the printer's E: drive (`^HWE:*.*`);
    - compare them with the fonts the station's templates need;
    - install any that are missing (`~DY`), using the font library. The kiosk
      gets them from a new **kiosk-scoped route that downloads a font**,
      limited to fonts the move's templates use;
    - re-check after installing.
  - **Every check must be green to finish** (Jimmy):
    - Paper, head and pause problems say what to fix, with a **Recheck**
      button.
    - A check that can't be fixed at the station, such as a font the templates
      need that isn't in the portal's font library, shows red with what to do.
      **"Finish anyway"** is offered **only when the person signed in with a
      user account. A move-password session must resolve every item.**
  - **"The station's templates"** *(my call)* are the downloaded templates of
    the chosen kind: Top templates for a Top station, Front templates for a
    Front one. The DPI check passes when at least one exists at the printer's
    DPI. The fonts check covers the fonts those templates use.
- **Test labels:** a modal using the report-generate header pattern, sized to
  its content, with two choices:
  - **Alignment label:** concentric boxes filling the whole label at **4x2 or
    2x1** (default: 4x2 for Top, 2x1 for Front), at the printer's DPI. This
    reuses `AlignmentTestModal`'s box routine.
  - A **mock-data test label**: fixed sample values for every placeholder,
    filled in with the portal's own renderer (see 4.3).
    - A Top station uses **Generic Rack and RU** at the printer's DPI.
    - A Front station uses its Front template at the printer's DPI.
    - A template only available at another DPI is skipped, with a note
      *(my call)*.

  After printing, **horizontal and vertical offset** inputs (dots, may be
  negative) are shown with a **Reprint** button.
  - The offsets reuse the kiosk's existing alignment shift: Printer tools'
    `applyPrintSettings`, which writes `^LS`/`^LT` and handles negative values.
    So the Label Station and Printer tools stay consistent *(my call; this
    replaces the earlier `^LH` idea, which can't go negative)*.
  - The station's label type, printer (USB, or network IP), DPI and offsets
    are kept in the laptop's shared setup on the edge. They are also reported
    to the portal in the kiosk's config document as a `label_station` section,
    so they show on the kiosk's details page *(my call)*.
- **Done:** the step can be finished once every check is green. Generating
  labels (phase 2) starts after this point; in phase 1, setup just finishes.

### 4.3 How finished ZPL is produced
- **Portal:** labels are filled in by the portal's existing renderer
  (`labels/generate/engine.render_label` with `placeholder_values`). Phase 1's
  mock-data test label is rendered by the portal through a new **kiosk route
  that renders one test label** (template plus mock values plus DPI) and
  returns ZPL. On the laptop, the edge passes this through (online only; the modal keeps the rendered label for reprints).
- **Web kiosk:** no Label Station yet, so no generation there.
- **Laptop (phase 2):** the standalone script uses **the same renderer code**
  as the portal. It is a shared Python module, not a copy, so its output is
  byte-for-byte identical.

## 5. Decisions phases 2–4 rely on

- **Template per asset** *(my guess, Jimmy to confirm in phase 2)*:
  - **Top:** the Top template linked to the move's destination site, then the
    source site, then a global Top template. If none exist, Generic Rack and
    RU.
  - **Front:** a Front template for the site, then the global Front template.

  Within that template, the version matching the printer's DPI is used. This
  is the portal generator's site-first rule (`generate/select.py`).
- **Stored label set:** one finished ZPL string per asset for the chosen label
  type, plus what it was generated from. That covers:
  - template ids and versions;
  - an asset data fingerprint;
  - the DPI.

  That way phase 2 can tell when data or templates changed.
- **The yellow alert** is a full-screen takeover, like the off-move alarm but
  yellow, shown on every page of a Label Station while regeneration runs.

## 6. Non-goals

- Brother P-touch printers. This is Zebra ZPL only.
- iOS printing (placeholder only).
- Editing templates on the kiosk.
- Label types other than Top and Front at a Label Station. Container labels
  keep their existing page.

## 7. Left to the builder

- Exact copy, card layouts and component structure. Reuse kiosk idioms and the
  existing Printer tools pieces: `PrinterHealth`, `healthChips`,
  `AlignmentTestModal` and the font install commands in
  `portal/src/labels/zebraCommands.ts` / `zebraUsb.ts`.
- The edge's printer transport API shape.
- The exact mock values for the test label.
