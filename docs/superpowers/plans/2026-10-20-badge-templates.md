# ID Badge Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ID badge templates in the label builder — a built-in ID Badge type with people fields, an image element (person photo, person logo, static image) printed as dithered Zebra graphics that match the canvas dot for dot, Load from person…, and a company logo in System settings.

**Architecture:** People fields are a new pure catalog group with a `person_values(payload)` builder; images are a schema 3 element resolved server-side (Pillow prep in its own module) into gray rasters, dithered by one integer algorithm implemented identically in Python (compile) and TypeScript (canvas), and emitted as `^GFA` Z64. Badge templates never reach kiosks.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (Postgres), Pillow (new explicit API dependency), React + TypeScript + Vitest (portal), the shared `serversherpa.labels` core.

**Spec:** `docs/superpowers/specs/2026-10-20-badge-templates-design.md` (recon fact sheet: `.superpowers/badge-recon.md` at the repo root, git-ignored).

## Global Constraints

- Build on main **after** the `label-guards-tips` merge (rebase/merge main in before Task 1); re-slug that batch's tests that use `id_badge` as a custom type.
- The laptop edge never imports Pillow: `zpl.py`, `compile.py`, `model.py`, `render.py`, `fields.py`, `label_values.py`, `pick.py`, `template_fonts.py`, `dither.py` are standard-library-only; Pillow lives only in `labels/image_prep.py`, imported lazily by API code.
- Byte parity: the canvas bits equal the compiled bits — same server gray raster, same integer dither (`dither.py` ≡ `dither.ts`, pinned by `labels/fixtures/dither.json`).
- Images only on ID Badge (`id_badge`) templates in ZPL (API-enforced, 422 `images_badge_only`). A design with an image is schema 3; without, schema 2; the edge stays `SUPPORTED_SCHEMA = 2`.
- Person keys never collide with existing keys (`person_rfid_tag`, not `rfid_tag`). Image elements use `source`, never `field`.
- Gates: sample-people, sample-person, raster, image library: `labels:view` + rank 80. Compile resolves photo/logo only at rank 80+. Branding: `settings:view` to read, `settings:change` to write.
- A missing storage object degrades to "no image", never a 500. Decoded images capped at 40 megapixels.
- Migration **0104** (check every worktree and the dev DB before numbering; 0103 is head today).
- American English; report-generate modal headers, sized to content, rounded corners; portal list/dropdown idioms; `naturalCompare` / `natural_key`; never stage `.env`, `.venv`, `.superpowers`, `node_modules`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never contact a printer; never touch the dev DB outside tests.

## Review Focus

1. A transparent PNG logo or a V2-imported avatar with EXIF rotation — prints the right way up on white, not a black square (Task 3).
2. A person with no photo, no partner, an archived parent partner, or a deleted logo object — no 500; the image is empty (or the outlined box) and the canvas agrees (Tasks 3, 5).
3. The dithered canvas and the compiled `^GFA` differ by even one dot at 203/300/600 or at 90/270 rotation — parity tests decode the Z64 back to bits and compare with `dither.ts` output (Tasks 2, 5).
4. A badge template linked to a move's site or named "…generic…" — never in the kiosk sync, never in the edge font check, never in Generate/Print pickers (Task 1).
5. A rank-60 admin compiling a badge with `person:id` of someone else — photo and logo stay empty; a non-existent or hidden-identity `person:id` → 422 (Task 3).

---

### Task 1: The ID Badge type and people fields

**Files:**
- Create: `api/migrations/versions/0104_badge_templates.py` (seed `("type","id_badge")` label "ID Badge" with `ON CONFLICT DO UPDATE` activate/label/sort; table `label_images` — id uuid pk, name text, storage_key text, width int, height int, mime text, size_bytes int, created_by uuid fk people null, created_at, deleted_at null; index on deleted_at)
- Modify: `api/src/serversherpa/db/models.py` (`LabelImage`), `api/tests/conftest.py` (`LABEL_VOCAB_SEEDS`), `api/src/serversherpa/labels/fields.py`, `api/src/serversherpa/labels/kiosk_templates.py`, `api/src/serversherpa/labels/generate/__init__.py`, `api/src/serversherpa/api/routes/labels.py` (`/labels/fields`, generate preview), `api/pyproject.toml` (add `pillow>=10`), `portal/src/lib/labels.ts`, `portal/src/components/labels/builder/fieldCatalog.ts`, `portal/src/pages/GenerateLabels.tsx`, `portal/src/pages/PrintLabels.tsx`, `portal/src/components/labels/builder/NewTemplateModal.tsx`
- Re-slug: every test from the label-guards batch that uses `id_badge` as a custom type (`api/tests/test_label_fields.py`, `test_labels_vocab_api.py`, `test_label_template_tree_api.py`, portal `NewTemplateModal.test.tsx`, `fieldCatalog.test.ts` — grep `id_badge`) → `shelf`
- Test: `api/tests/test_label_person_fields.py`, `api/tests/test_migration_0104_badge_templates.py`, portal tests beside each modified file

**Interfaces:**
- Produces: `fields.PERSON_LABEL_TYPES = ["id_badge"]`; `fields.PERSON_KEYS` (the 18 keys of spec §4.2 incl. `person_rfid_tag`, `badge_id`, `badge_short`); `fields.person_values(payload: dict) -> dict[str, str]` where payload = `{person: {...}, person_type: "Staff"|"Worker"|"", company, parent_company, roles: [str], level: {key,title}|None, worker_status_label, ...}` (built by the API in Task 3); `groups_for("id_badge")` = Person group only; unknown types = every group except Person; `mock_field_values("id_badge")` = person keys only, no `ft:`; `kiosk_templates.KIOSK_LABEL_TYPES = ("top","front","rail","container","container_info")`; portal `isPersonLabelType(type)`.

- [ ] **Step 1: Failing tests.** `test_person_group_only_for_id_badge` (`keys("id_badge") == set(PERSON_KEYS)`; `"person_name" not in keys("shelf")`), `test_person_values_staff_and_worker` (a staff payload → `person_type "Staff"`, `company "Cumulus Solutions Group"`, `roles "Admin, Staff"`, `badge_id` = full id, `badge_short` = first 8; a worker payload → `trade`, `level "L3 Technician"`, `parent_company`), `test_person_values_blanks` (missing preferred/email → `""`), `test_mock_id_badge_has_no_ft_keys`, `test_fields_route_id_badge_no_ft_headers`, `test_move_template_set_skips_badges` (an active `id_badge` child linked to the move's destination and named "Generic badge" → not in the set), `test_generate_preview_skips_person_types`, `test_enqueue_refuses_id_badge` (422 `invalid_label_types`), migration up/down test (row present + active; `label_images` exists; downgrade drops the table and the row), portal: `isPersonLabelType`, `allowsFromTo('id_badge') === false`, Generate/Print pickers hide ID Badge, New template picks the `id-badge` size when ID Badge is chosen.
- [ ] **Step 2:** Run them — FAIL.
- [ ] **Step 3:** Implement. Mock values: a plausible worker (`"Jordan Rivera"`, `"Rivera Electric"`, `"L3 Technician"`, a fixed uuid for `badge_id`). Keep `fields.py` database-free (the purity test stays green).
- [ ] **Step 4:** PASS; then the whole API labels set, edge suite, portal suite.
- [ ] **Step 5: Commit** `feat(labels): the ID Badge type and people fields; badges never reach kiosks`

### Task 2: Images in the pure core — dither, `^GFA`, schema 3

**Files:**
- Create: `api/src/serversherpa/labels/dither.py`, `api/src/serversherpa/labels/fixtures/dither.json`, `portal/src/labels/builder/dither.ts`, `api/tests/test_label_dither.py`, `portal/src/labels/builder/dither.test.ts`, `api/tests/test_edge_import_without_pil.py`
- Modify: `api/src/serversherpa/labels/model.py` (`ImageEl`, `SCHEMAS = (1,2,3)`, splits for `schema >= 2`, image only in schema 3, schema 3 requires an image), `api/src/serversherpa/labels/zpl.py` (`_v2_image`, Z64 encoder, banding, `compile_zpl(..., images=None)`), `api/src/serversherpa/labels/compile.py`, `render.py` (pass images through; image elements never "unknown keys"), `portal/src/labels/builder/model.ts` (`ImageElement`, `DesignV2.schema: 2 | 3`, `serializeDesign` derives the schema, parse/validate), `kiosk_laptop/edge/tests/*` (schema-3-as-newer → 4)

**Interfaces:**
- Produces: `dither.Params(brightness:int, contrast:int, threshold:int, mode:"dither"|"threshold", invert:bool)`; `dither.bitmap(gray: bytes, width: int, height: int, p: Params) -> bytes` (packed 1-bit rows, MSB left, 1 = black, `ceil(width/8)` bytes per row, pad bits 0); TS `ditherBitmap(gray: Uint8Array, width, height, p): Uint8Array` identical; `zpl.z64(raw: bytes) -> str` (`:Z64:` + base64(zlib.compress(raw)) + `:` + CRC-16/XMODEM of the base64 text, 4 uppercase hex); `compile_zpl(design, dpi, substitutions, *, images: Mapping[str, Bitmap] | None = None)` where `Bitmap = (width:int, height:int, bits:bytes)` already rotated; `model.ImageEl(source, image_id, fit, mode, brightness, contrast, threshold, invert, hide_when_empty)`.
- Algorithm (spec §4.5, pinned): LUT `v' = clamp(((v-128)*contrast)//100 + 128 + brightness*255//100, 0, 255)` (integer floor division as in Python; TS uses `Math.floor`); threshold mode: black = `v' < threshold`; dither mode: Atkinson in raster order (no serpentine), Int32 accumulator, black = `acc < 128`, error `(acc - (black ? 0 : 255)) >> 3` added to (+1,0), (+2,0), (−1,+1), (0,+1), (+1,+1), (0,+2); invert flips bits after; pack.

- [ ] **Step 1: Failing tests.** `test_dither_fixture` (every case in `dither.json` — gray input, params → packed hex — equal; cases: flat 0/128/255, gradients 13×7 and 64×9 (odd widths exercise pad bits), contrast 0/300, brightness ±100, invert, threshold 1/254); `dither.test.ts` reads the same JSON; `test_z64_crc_and_roundtrip` (decode back → identical raw; CRC of a known string matches `binascii.crc_hqx`); `test_gfa_placement_and_banding` (an image at x=0.5 in, y=0.25 in, 300 DPI → `^FO150,75^GFA,c,c,d,:Z64:`; a bitmap taller than `99999//d` rows splits into bands with `^FO` y advancing by band height); `test_image_hidden_when_empty` (no bitmap + hideWhenEmpty → no `^GF`; hideWhenEmpty off → a 2-dot `^GB` outline of the footprint); `test_schema_rules` (image in schema 2 → DesignError; schema 3 without image → DesignError; splits kept in schema 3); `test_rotation_swaps_footprint` (90° → footprint w/h swapped, `^FO` at footprint top-left); `test_edge_import_without_pil` (import the edge's module set with `sys.modules['PIL'] = None` succeeds); TS model tests (`serializeDesign` sets schema 3 iff an image exists; parse accepts 3; unknown-type test updated).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (no Pillow anywhere in these files). **Step 4:** PASS + the whole API labels set, edge suite (with the 3→4 test updates), portal suite. Vegas golden unchanged.
- [ ] **Step 5: Commit** `feat(labels): image elements in the shared core — integer dither, Z64 ^GFA, schema 3`

### Task 3: Server image resolution, the image library and API gates

**Files:**
- Create: `api/src/serversherpa/labels/image_prep.py` (Pillow, lazy), `api/src/serversherpa/labels/people_badge.py` (DB-backed: build the person payload, staff/worker rule, logo walk), `api/tests/test_label_image_prep.py`, `api/tests/test_label_images_api.py`, `api/tests/test_label_people_badge.py`
- Modify: `api/src/serversherpa/api/routes/labels.py` (`_parse_v2`/`_is_v2` accept 3 at their seven call sites; `images_badge_only`; compile resolves images; `POST /labels/images` upload, `GET /labels/images`, `DELETE /labels/images/{id}` soft delete; `POST /labels/images/raster`; preview cap 250,000), `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/labels/templates_tree.py` (store `schema_version` from the design at :420/:451/:690/:674; :340 filter stays `< 2` for legacy), `api/src/serversherpa/devtools/cleanup.py` (`_key_sources` adds `label_images.storage_key` where not deleted and the branding logo key)

**Interfaces:**
- Consumes: Task 2 `dither.bitmap`, `compile_zpl(images=)`; Task 1 `fields.person_values`.
- Produces: `image_prep.gray_raster(data: bytes, w_dots: int, h_dots: int, fit: str, rotation: int) -> (width, height, gray: bytes)` (EXIF transpose, alpha onto white, ITU-601 luma, cover/contain with white letterbox, `Resampling.BOX`, exact transpose; raises `ImageTooLarge` past 40 MP); `people_badge.person_payload(db, person_id) -> dict | None` and `people_badge.logo_key(db, person) -> str | None` and `people_badge.photo_key(person) -> str | None`; `labels.resolve_images(db, design, dpi, samples, actor) -> dict[str, Bitmap]` (static by `imageId`, photo/logo by `samples["person:id"]` only when `actor` rank ≥ 80; missing object → omitted); raster route returns `application/octet-stream` gray bytes with `X-Raster-Width`/`X-Raster-Height` for `{source, image_id?, person_id?, w_in, h_in, dpi, fit, rotation}`.

- [ ] **Step 1: Failing tests.** prep: a transparent PNG logo → white background, not black; an EXIF-rotated JPEG → upright; cover crops center, contain letterboxes white; 90° transposes; a 50 MP PNG → `ImageTooLarge`. people_badge: staff by global role (role `scope_anchor == 'global'`) even with the worker role; worker via role or profile; logo walk — partner with grandparent logo → grandparent; archived ancestor skipped; no logo in chain → own partner's; none → None; `parent_company` = top non-archived ancestor name. API: upload/list/soft-delete images (rank 80; rank 60 → 403); raster bytes length = w×h; compile with an image on a `top` template → 422 `images_badge_only`; type PATCH of a badge-with-image to `top` → 422; compile at rank 80 with `person:id` includes `^GFA`; at rank 60 → no `^GFA` for photo/logo; `person:id` not a UUID / unknown / hidden identity → 422; a deleted storage object → no `^GFA`, 200; schema 3 saved → `schema_version` 3 on parent and children; preview accepts 200k characters.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; prep + dither run via `anyio.to_thread.run_sync`; `functools.lru_cache`-style small cache keyed by (storage_key, w, h, fit, rotation). **Step 4:** PASS + whole API labels set + edge suite. **Step 5: Commit** `feat(labels): server-side badge images — prep, people, library, raster, gates`

### Task 4: Branding and the sample-people routes

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (`branding` section: `company_name` "Cumulus Solutions Group", `company_logo_key` None), `api/src/serversherpa/api/routes/settings*.py` (find the System settings routes: `GET /settings/branding`, `PATCH /settings/branding` name, `PUT /settings/branding/logo` upload, `DELETE /settings/branding/logo`), `api/src/serversherpa/api/routes/labels.py` (`GET /labels/sample-people?q=`, `GET /labels/sample-person?person_id=`), portal System settings: a **Branding** tab (company name, logo upload with preview and Remove), `portal/src/lib/api.ts`
- Test: `api/tests/test_settings_branding.py`, `api/tests/test_label_sample_people.py`, portal Branding tab test

**Interfaces:**
- Consumes: Task 3 `people_badge.person_payload`; Task 1 `person_values`.
- Produces: `GET /labels/sample-people?q=&limit=25` → `[{person_id, name, person_type, company, has_photo, has_logo}]` natural-sorted, archived and hidden move identities excluded; `GET /labels/sample-person?person_id=` → `{person_id, values: {key: text}, has_photo, has_logo}`; branding `GET` → `{company_name, has_logo, logo_url}`.

- [ ] **Step 1: Failing tests.** branding: defaults; admin uploads a PNG (stored original; key in config); `settings:view` reads, staff without `settings:change` → 403 on PUT; remove clears the key; `person_values` for staff uses the configured company name. sample-people: search by name parts; staff and workers both listed with type; archived excluded; hidden move identity excluded; rank 60 → 403. sample-person: values for a worker (trade, level, company, parent_company, badge ids); unknown person → 404 `person_not_found`. Portal Branding tab: shows name and logo, upload calls the route, Remove asks once (report-generate confirm dialog) and clears.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(settings,labels): Branding (company name and logo); sample people for badges`

### Task 5: The Image element in the builder

**Files:**
- Modify: `portal/src/components/labels/builder/canvasActions.ts` (tool `image`, defaults: photo cover/dither 0.8×1.0 in, logo/static contain/threshold 1.0×0.5 in), `CanvasToolbar.tsx` (Image tool, shortcut **I**, only on `id_badge` ZPL templates), `portal/src/labels/builder/shortcuts.ts`, `geometry.ts` (kind `image`: free box, ⇧ keeps ratio), `CanvasElement.tsx` (`ImageBody`: fetch raster per element at the view DPI — debounced 250 ms while resizing — dither with `dither.ts`, draw into an SVG `<image>` with `image-rendering: pixelated`, white transparent; dashed placeholder labeled "Photo"/"Logo"/"Image" when no bitmap), `PropertiesPanel.tsx` (Image section: Source, Static image picker + Upload…, Fit, Look (Photo/Logo), Brightness, Contrast, Threshold (logo look), Invert), `builderEdits.ts` (`HOLDERS` entries for every image property), `PlacedFieldsTable.tsx` (non-field rows name "Photo"/"Logo"/"Image"), `PreviewPanel.tsx`/`zplPreview.ts` (send `person:id` with samples; "Too large to preview at this DPI"), `portal/src/pages/LabelBuilder.tsx` (schema 3 accepted; Test print sends samples with `person:id`), `portal/src/lib/api.ts` (raster, image library calls)
- Test: Canvas/CanvasElement/PropertiesPanel/LabelBuilder tests; `portal/src/labels/builder/imageParity.test.ts`

**Interfaces:**
- Consumes: Task 2 `ditherBitmap`, `ImageElement`; Task 3 raster + library routes.
- Produces: `fetchRaster(el, dpi, personId)` (cached by element props + dpi + person); `ImageBody`.

- [ ] **Step 1: Failing tests.** Image tool hidden on a `top` template and present on an ID Badge template; placing an image creates `{type:'image', source:'photo', fit:'cover', mode:'dither'}` and the design serializes as schema 3; removing the last image → schema 2; ImageBody draws exactly the bits `ditherBitmap` returns for a mocked raster (compare the `ImageData` passed to `putImageData`); placeholder when no sample person; rotation 90 swaps the drawn footprint; Properties edits patch only image elements in a mixed selection; Brightness/Contrast change the drawn bits; Static image Upload… posts and selects; imageParity: for three fixture rasters × 203/300/600 × rotations 0/90, TS bits equal the Python fixture bits (from `dither.json` extended cases).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + whole portal suite + build + guardrails. **Step 5: Commit** `feat(labels): the Image element in the builder — photo, logo, static, drawn as it prints`

### Task 6: Load from person… and crop fixes

**Files:**
- Create: `portal/src/components/labels/builder/LoadFromPersonModal.tsx` (+ test)
- Modify: `portal/src/components/labels/builder/FieldPanel.tsx` (Load from person… on `id_badge` templates; Load from asset… elsewhere), `portal/src/pages/LabelBuilder.tsx` (apply: replace every person key, `""` for blanks, set `person:id`; Clear sample person resets them), `portal/src/components/ImageCropModal.tsx` (fill white before `drawImage`), spec §4 touch-ups if any behavior differs
- Test: `LoadFromPersonModal.test.tsx`, FieldPanel/LabelBuilder tests, `ImageCropModal.test.tsx`

**Interfaces:**
- Consumes: Task 4 sample-people / sample-person; Task 5 raster refresh when `person:id` changes.

- [ ] **Step 1: Failing tests.** The dialog (report-generate header "<template> · Load from person", a search box, results with name, Staff/Worker chip, company, photo/logo presence, natural order; picking loads values) ; loading person B after person A leaves none of A's values (blanks become `""`); `person:id` set and images re-fetch; Clear sample person removes every person key and `person:id`; Load from asset… still shows on `top` templates and not on ID Badge; ImageCropModal fills white (a transparent pixel comes out white in the JPEG blob — assert the canvas context's `fillRect` call precedes `drawImage`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + whole portal suite + build + guardrails. **Step 5: Commit** `feat(labels): Load from person… for badge templates; crops fill white`
