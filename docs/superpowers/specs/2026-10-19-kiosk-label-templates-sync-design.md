# Kiosk label templates download — design

Date: 2026-10-19. This is the first step of Label Printing on the kiosk (web and
laptop). It follows the 2026-10-19 change that added each asset's roster fields
to the move sync (main 8b4abbf5).

## 1. Intent

A Label Printing station has to print labels for the move it's set up for,
including offline. To do that, the kiosk needs the right label templates on hand,
the same way it already holds the move's assets.

This step only **downloads and stores** the templates. Choosing which template
to print and printing itself come next, in a separate step. Jimmy wants the
kiosk's and the portal's label generation to feel like one experience, so this
download must give the kiosk everything the portal uses to render a label.

## 2. Which templates a kiosk downloads (Jimmy, 2026-10-19)

When a kiosk syncs a move, it downloads **active** templates matching any of these:

1. **Every Front label template** (`label_type = front`), whatever its site.
2. **Every template assigned to the move's destination site.**
3. **Every template assigned to the move's source site.**
4. **Every template with "Generic" in its name.** The match ignores case and
   can be anywhere in the name *(my call on how "Generic" matches)*.
5. **Every Container and Container Info template** (`label_type` `container`
   and `container_info`).
6. **Fallback:** when **no active template of any type** is assigned to the
   destination site, the kiosk also gets the template named **Generic Rack and
   RU**. It is only included when active, like everything else. Rule 4 already
   catches it whenever it is active, but the fallback keeps it guaranteed if
   rule 4 is ever narrowed.

**General rules:**
- **The source and destination sites** are the move's origin and destination
  sites. The kiosk device's own site plays no part. If the move has no
  destination site, rule 2 matches nothing and the fallback applies. If it
  has no source site, rule 3 matches nothing *(my call)*.
- **Inactive templates are never downloaded.**
- **Each template once:** a template matching several rules is downloaded once.
- **Both DPIs:** where a match exists at both 203 and 300 DPI, **both are
  downloaded**. They are separate templates with their own names, e.g.
  "Container Label 4x6 203dpi" / "300dpi". When printing, the kiosk will pick
  the one that matches the connected printer's DPI.
- **Rail and Top templates** are included only when a rule above catches them
  (site-assigned, Generic, or the fallback).

## 3. What each downloaded template carries

Everything the kiosk needs to fill in and print a label **without the portal**:

- **Identity and filters:** id, name, label type, size key, DPI key, language
  key, version, `updated_at`, and the names of its assigned sites.
- **Why it was picked:** a **set** of reasons from destination site, source
  site, front, generic, container and fallback. A template matching several
  rules lists them all *(my call)*. This is so the next step can prefer a site-specific
  template the way the portal's generator does (`labels/generate/select.py`:
  site first, then global).
- **Printer code with `{placeholder}` tokens intact:**
  - A `code` template sends its stored code as is.
  - A `design` template is converted on the server with the portal's own
    compiler (`labels/compile.py` with no substitutions, which leaves tokens
    intact), at the template's own size and DPI. So the kiosk never needs a
    compiler of its own.
- **`generation_rules`** (position split and length limits) are sent unchanged,
  so the kiosk can produce the same extra placeholder values the portal's
  generator does.
- **The size and DPI vocabulary details** the kiosk needs to print: label
  width and height in inches, and printer dots.

- **Fonts and graphics:**
  - Design templates have only text, barcode, QR, line and box elements, and
    text uses the printer's built-in font by point size. So their converted
    code is self-contained.
  - A `code` template that names a printer-installed font relies on that font
    being installed through Printer tools, as it does in the portal today. No
    font files are downloaded.
- **Container templates** come down in the same shape as the others. Their
  values (container name, tag and so on) are the next step's concern.

## 4. Delivery

- **A new kiosk route** returns the move's template set, using the same
  rules for both access paths:
  - `kiosk:view` sessions, limited to the move like the other move-sync routes;
  - a station-key twin, like the other `/kiosk/station/sync/*` routes.
- **Same sync as the move data:** the template set comes down whenever the
  move's data syncs, and is stored with it:
  - the **web kiosk** keeps it in its browser storage alongside the assets;
  - the **laptop edge** caches it like the other sync responses, so every
    browser on the laptop and the offline path see it.
- **Full set every time:** each call returns the whole set (no `since` or
  delta). If fetching the templates fails, the rest of the move sync still
  counts, and the kiosk keeps its previous template set *(my call)*.
- **Access** copies `/kiosk/sync/containers` exactly: the move lock and
  move-password checks for sessions, and the station-key twin for the move the
  key was issued for. The edge caches it the same way as the other sync
  responses, with no special expiry.
- **Changes on the portal:** a template that is edited, deactivated or
  reassigned on the portal changes what the next sync returns. The kiosk
  replaces its stored set with each successful sync, and removes templates
  that stop matching.

## 5. Not in this step

- Choosing the template to print, picking 203 vs 300 by the connected printer,
  filling in values, and printing. That's the next step, and it should reuse the
  portal's selection and value logic so both feel the same.
- Any change to how the portal's own label generator chooses templates.
- Android and iOS. The route is shared, but no app work happens here.

## 6. Left to the builder

- The route path and response field names.
- How the kiosk stores the set: IndexedDB on the web, the sync cache on the
  edge.
- Whether the converted code for a design template is cached on the server.
  Templates change rarely, and a template's `version`/`updated_at` can key a
  cache.

## 7. Risk to note for the next step

The portal converts a design template **with values already filled in**
(`compile_parsed_design(..., subs=values)`), which may escape or measure text
differently from converting with tokens intact and substituting afterward. The
next step must check that a kiosk-filled label is byte-identical to the
portal's generated label for the same asset. If it isn't, the conversion has to
be shared some other way.
