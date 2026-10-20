# ID badge templates — design

Date: 2026-10-20. Builds on the label builder (`2026-10-19-label-builder-design.md`). Recon: `.superpowers/badge-recon.md` in the repo root (a fact sheet with file:line for every touchpoint; it is git-ignored scratch, so this spec repeats what matters).

## 1. Intent

Jimmy wants to build ID badge templates in the label builder: a badge for a person (a worker on the floor or a staff member), printed on a Zebra label printer, carrying their name and details, their photo, a logo, and a code the kiosk time clock can scan. **This work is template building only** — designing, previewing and test-printing a badge with a real person's details. Printing badges for people (from People pages, a move's team, or the time clock) comes later.

## 2. Goals, non-goals, anti-goals

Goals:
- A built-in **ID badge** label type whose field list is people fields only.
- People fields for workers and staff (§4.2).
- An **image element** in the builder with three sources: the person's **photo**, a per-person **logo**, and a **static image** uploaded into the template (§4.3).
- Images print as Zebra graphics, converted to black and white (dithered photos, thresholded logos), and the canvas shows the exact dots that will print at the DPI being viewed.
- **Load from person…** fills a template's samples from a real worker or staff member, including the photo and logo the canvas and Test print use.
- A **company logo** in System settings (the Cumulus Solutions Group logo staff badges carry).

Non-goals (later): printing badges for people anywhere outside the builder's Test print; card printers (PVC; not ZPL); re-issuable badge tokens (`badge_uid`, To-Do #29); RFID encoding.

Anti-goals: a badge template reaching a kiosk; an image making an older laptop print a wrong label; a photo that looks one way on the canvas and another on paper; Pillow becoming a dependency of the laptop edge.

## 3. Jimmy's decisions

- Badges print on a **Zebra label printer** (ZD421-class, ZPL), not a card printer.
- The badge carries the person's **avatar (cropped)**; **staff** get the **Cumulus logo**, **workers** get their **parent partner's logo**.
- Fields for **workers (crew)** and **portal users (staff)**.
- **No print destination yet** — just template building.

## 4. How it works

### 4.1 The ID badge label type

- Migration **0104** seeds vocab `("type", "id_badge")`, label **"ID Badge"** (matching the size's label), sorted after the existing types, with `ON CONFLICT DO UPDATE` (activate, set label and sort) in case a designer already made a pending `id_badge` row via Custom…; `conftest.LABEL_VOCAB_SEEDS` gains it. Choosing the ID Badge type on New template preselects the `id-badge` size. The `id-badge` **size** (CR80, 3.375 × 2.125 in) already exists (migration 0042).
- `fields.py` makes `id_badge` a first-class type: its field groups are the **Person** group only; no From-To columns (`allowsFromTo` false, `/labels/fields` omits headers, `mock_field_values("id_badge")` mocks person keys only). Generation never offers or accepts it: the generate preview skips person types, the Generate Labels and Print Labels pickers hide them, and `enqueue_run` refuses one with 422 `invalid_label_types` (the existing code). `generated_labels` keeps its asset/container check.
- Custom label types (the New template **Custom…** type from the label-guards batch) get every asset/move/site/container group but **not** the Person group — people fields only make sense on `id_badge`. *(My call.)*
- **Kiosk sync:** `move_template_set` only ever returns the label types a kiosk prints — `top`, `front`, `rail`, `container`, `container_info`. A badge (or custom-type) template never syncs, whatever its site links or name. *(My call; the recon found badges could leak in through site links or a "generic" name.)*

### 4.2 People fields (group "Person", label type `id_badge`)

| Key | Label | Value |
|---|---|---|
| `person_name` | Name | `preferred_name or first_name` + `last_name` (the existing `display_name`) |
| `first_name` | First name | |
| `last_name` | Last name | |
| `preferred_name` | Preferred name | blank when none |
| `person_type` | Person type | "Staff" or "Worker" (§4.4) |
| `company` | Company | staff: the company name from System settings › Branding ("Cumulus Solutions Group"); worker: their partner's name; else blank |
| `parent_company` | Parent company | worker: the name of the partner whose logo they get (§4.4); else blank |
| `job_title` | Job title | `people.job_title` |
| `roles` | Roles | staff: their active global role labels, natural order, comma-separated |
| `trade` | Trade | worker profile `trade` |
| `level` | Level | worker level key + title, e.g. "L3 Technician" |
| `worker_status` | Worker status | the worker status label |
| `employee_id` | Employee ID | `people.external_id` |
| `email` | Email | `people.email` (not the login email) |
| `phone` | Phone | |
| `person_rfid_tag` | RFID tag | display form (zero-stripped, upper-case); keyed apart from the asset `rfid_tag` |
| `badge_id` | Badge ID | `str(person.id)` — the full 36-character id the time clocks and the server scan matcher accept; put this in a QR code |
| `badge_short` | Badge ID (short) | `str(person.id)[:8]` — the short form the time clocks accept; for Code 128 or a printed line (the full id is too wide for Code 128 on a badge) |

Mock values give a plausible worker. The value rules (Split, Strip, Max, Number pad) apply as for any field.

### 4.3 The image element

Design JSON (schema 3, §4.6):

```json
{ "id": "...", "type": "image", "source": "photo" | "logo" | "static",
  "imageId": "<label_images id>"  /* static only */,
  "fit": "cover" | "contain", "mode": "dither" | "threshold",
  "brightness": 0, "contrast": 100, "threshold": 128, "invert": false,
  "x": 0, "y": 0, "w": 1, "h": 1, "rotation": 0, "locked": false, "hideWhenEmpty": true }
```

- The source key is **`source`, never `field`**, so images stay out of `design_field_keys`, unknown-key reporting and sample loading.
- Defaults: photo → `cover` + `dither`; logo and static → `contain` + `threshold`. `brightness` −100..100, `contrast` 0..300 (percent), `threshold` 1..254.
- `hideWhenEmpty` (default on): a photo or logo the person doesn't have prints nothing; off, it prints an outlined box so the gap is visible on a test print.
- Static images live in a new **`label_images`** table (id, name, storage key, width, height, mime, created_by, created_at), uploaded from the builder (PNG, JPEG, WebP, GIF; 5 MiB; the original is stored uncropped). Designs reference them by id; the cleanup tab's storage sweep lists their keys. *(My call: by reference, not inline — a design is copied into every version and DPI child.)*
- The builder tool **Image** (shortcut **I**); the Properties panel: Source (Photo / Logo / Static image with a library picker and Upload…), Fit, Mode (Photo / Logo look), Brightness, Contrast, Threshold (logo look), Invert, then the usual position, rotation, hide-when-empty and lock. Resizing keeps the box free; the image fits inside it by `fit`.
- Thermal printers print black or white: **photos are dithered** (Atkinson), **logos thresholded**. White is transparent (a printer can't print white over black), so z-order follows the element list.

### 4.4 Whose logo, who is staff

- **Staff vs worker** *(my call, from the recon's suggestion)*: a person with any active **global-anchored role** (developer, founder, super_admin, admin, staff) is **Staff** — even if they also hold the worker role. Otherwise a person with an active **worker** role or a worker profile is **Worker**. Anyone else (client or vendor contacts, external) gets `person_type` blank and no logo.
- **Staff logo:** the company logo from System settings › Branding.
- **Worker logo:** the worker's partner (worker profile `partner_id`); walk its parent chain (skipping archived partners) to the **top-most ancestor that has a logo**; if none in the chain has one, the worker's own partner's logo; if that is missing too, no logo. *(My call on "parent partner": the top of the chain is the brand a crew wears; a partner with no parent is its own top. Easy to change if Jimmy means the immediate parent.)* `parent_company` is the top-most (non-archived) ancestor's name, whether or not it has a logo.
- The staff rule is computed from `Role.scope_anchor == 'global'`, not a hard-coded role list.

### 4.5 Images: one pipeline, two places

1. **Prep (server, Pillow):** a new `labels/image_prep.py` decodes the source (avatar key, logo key, company logo key or a `label_images` key), applies EXIF orientation (V2-imported avatars are stored raw), composites transparency onto white, converts to 8-bit gray, fits it to exactly the element's dot box at the DPI (`cover` center-crops, `contain` letterboxes in white; box-filter resample), and rotates by exact transposition. Pillow is imported lazily, only here; the laptop edge never imports this module (a test proves the edge's import set works with PIL blocked). Pillow is added to `api/pyproject.toml` explicitly.
2. **Dither (shared, integer-only):** `labels/dither.py` and its exact mirror `portal/src/labels/builder/dither.ts` apply the brightness/contrast table, then Atkinson (photo) or threshold (logo), then invert, then pack to 1-bit rows. Both are pinned byte-for-byte by a shared fixture `labels/fixtures/dither.json`.
3. **Compile:** `zpl.py` emits `^FO{x},{y}^GFA,{c},{c},{d},:Z64:{base64(zlib)}:{crc16}^FS` from the already-dithered bitmap, banded when a band would pass 99,999 bytes. `compile_zpl` gains an `images` argument (element id → bitmap); it stays pure and never fetches.
4. **Canvas:** the builder asks the API for the prepped gray raster of each image element at the view DPI (`POST /labels/images/raster`, bytes not URLs — no CORS, no tainted canvas), dithers it with `dither.ts`, and draws the bits into an SVG `<image>` (pixelated, white transparent). What you see is what prints.
5. **Compile route / Test print / preview:** resolve each image server-side with the same prep + `dither.py`, so the ZPL's bits equal the canvas's bits by construction (same gray raster, same integer dither).

The preview's ZPL size cap rises from 20,000 to 250,000 characters (a 1 in² photo is ~12k at 300 DPI and ~47k at 600 in Z64).

### 4.6 Schema 3

- A builder design containing any image element is **schema 3**; without images it stays **schema 2** (nothing changes for today's templates). The portal sets the schema when it serializes; the API accepts 2 and 3 for builder templates (every `== 2` gate: `_parse_v2`, `_is_v2` and their seven call sites, `parseDesign`, `DesignV2.schema`, the builder's "made before the label builder" check) and stores `schema_version` from the design (`templates_tree.py` no longer hard-codes 2).
- The laptop edge keeps `SUPPORTED_SCHEMA = 2`: a schema 3 design that ever reached it reports "needs a laptop update" and prints nothing. Its tests that use 3 as "a newer schema" move to 4.

### 4.7 Load from person…

- `FieldPanel`'s **Load from person…** (on `id_badge` templates; "Load from asset…" stays on asset types) opens a dialog with the report-generate header and a person search (workers and staff; archived and hidden move identities excluded).
- New route `GET /labels/sample-person?person_id=` — `labels:view` + rank 80 like `/labels/sample-values` — returns `{values: {key: text}, person_id, has_photo, has_logo}` from a pure `fields.person_values(payload)` (the API builds the payload; `fields.py` stays database-free).
- The sample person is remembered in the template's samples under the reserved key `person:id`, so the canvas, preview and Test print resolve the same photo and logo. Without a sample person, photo and logo elements draw a dashed placeholder on the canvas and print nothing (an outlined box if `hideWhenEmpty` is off).

### 4.8 System settings › Branding

- A new **Branding** section on System settings (admins): **Company name** (default "Cumulus Solutions Group") and **Company logo** (upload PNG/JPEG/WebP, original stored uncropped; preview; remove). Stored in the system config (`branding` section: `company_name`, `company_logo_key`); the cleanup sweep lists the key.

### 4.9 Test print and the Printer button

- Test print (⌘P) and the Printer dialog stay available on badge templates — printing the template with the sample person is template building. *(My call; the recon suggested gating it.)*
- Brother templates don't support images: the builder refuses an image element on a non-ZPL template ("Images print on Zebra (ZPL) templates only").
- **Hardware check for Jimmy:** `^GF` placement on the ZD421 with a ruler probe (as the QR offset was measured) before calling badges exact.

### 4.10 Where images are allowed *(builder check, my call)*

- Image elements are allowed **only on ID Badge templates in ZPL**. The API enforces it on create, save, and a `label_type`/`language_key` PATCH (422 `images_badge_only`); the Image tool is hidden on other templates. Static logos on asset labels need laptop-side image support and are later work.
- Schema consistency: the API returns 422 for an image element under schema 2 and for schema 3 without one; the portal derives the schema when it serializes. `model.py` treats Splits as present for `schema >= 2` (today `== 2` would drop them) and `SCHEMAS` becomes `(1, 2, 3)`.

### 4.11 Permissions and limits *(builder check, my calls)*

- `GET /labels/sample-people?q=` (search, new), `GET /labels/sample-person`, `POST /labels/images/raster`, and the label image library (`POST/GET /labels/images`, soft delete) are **`labels:view` + rank 80**, like `/labels/sample-values`. The compile route resolves photo and logo images only for rank 80+; below that they render empty. `person:id` must be a UUID of an existing person who is not a hidden move identity.
- The person search applies §4.4's staff/worker rule server-side and returns id, name, type, company, avatar presence and logo presence, natural-sorted; archived people and hidden move identities never appear; blacklisted workers do (a designer may need their badge layout).
- **Load from person…** replaces **every** person sample key, writing `""` for the person's blanks (no stale values from a previous person); clearing the sample person resets them.
- Image prep and dither run in a worker thread with a small LRU cache of prepped rasters; decoded images are capped at 40 megapixels (decompression-bomb guard) at upload and at prep; a preview past the 250,000-character cap shows "Too large to preview at this DPI" instead of failing.
- Static library images: PNG/JPEG/WebP/GIF, 5 MiB, originals stored uncropped, soft delete (an image in use degrades to "no image"); deleting is allowed while in use.
- Branding upload: `PUT /settings/branding/logo` (PNG/JPEG/WebP, 5 MiB, original stored), `settings:change`; the Branding tab is viewable with `settings:view`. `_key_sources` reads the logo key from the system config JSON.
- `ImageCropModal` fills white before drawing so transparent logos and avatars no longer turn black (affects every crop in the portal, intended). Partner logos stay cropped squares for now; storing originals is later work.

### 4.12 Geometry details

- An image fits into its unrotated `w × h` box at the DPI, then is transposed for 90/180/270; the footprint swaps as for shapes, with `x, y` its top-left.
- The outlined box for an empty photo/logo with `hideWhenEmpty` off is a 2-dot `^GB` (0.01 in at 203).
- Inverted text over an image XORs on paper (`^FR`); the canvas draws it the same way (difference blend), so what you see is what prints.
- Rasters are fetched one per element, debounced while resizing; the response is `application/octet-stream` with `X-Raster-Width`/`X-Raster-Height` headers.

### 4.13 Branches and process

- Built on top of the label-guards batch (custom types, rename, chips, tips). Its tests that use `id_badge` as an example custom type are re-slugged (e.g. `shelf`) in this work's first task, because `id_badge` becomes built-in.
- Hardware checks for Jimmy after merge: `^GF` placement with a ruler probe, and that a Z64 graphic prints at all on the ZD421 (Labelary ignores the Z64 checksum; a compressed-ASCII fallback stays behind one switch).

## 5. Constraints

- The laptop edge never imports Pillow; `zpl.py`, `compile.py`, `model.py`, `render.py`, `fields.py` stay standard-library-only (zlib, base64, binascii are fine).
- Byte parity: the canvas bits equal the compiled bits (shared integer dither, one gray raster from the server).
- A deleted avatar, logo or static image degrades to "no image", never a 500.
- American English; report-generate modal headers; portal list and dropdown idioms; natural sort.

## 6. Known risks (later work)

- **Time clock keyboard wedge:** a full-id QR scanned by a keyboard-wedge scanner selects the person at the 8th character (short-id match) and drops the rest; fix when badges are printed for real (Timeclock should wait for Enter or a pause before matching a hex-looking value).
- V2 badges (`people.qr_code`) don't scan in V3 — the import drops the column.
- The server scan matcher ignores the 8-character short form.
- Logos with light brand colors threshold to white; the Threshold and Invert controls are the remedy.
