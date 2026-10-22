# Android Label Printing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Android kiosk prints asset labels offline by scan to a network Zebra, from labels it generates itself with a new shared TypeScript generator that matches the laptop byte for byte.

**Architecture:** A pure TypeScript port of the laptop's label code lives in `kiosk/src/labelgen/`, proven against reference labels produced by the laptop's own Python path, and bundled into one JS file that Android runs in Jetpack JavaScriptEngine. Android syncs templates, fonts and full asset payloads into Room (first real migration), builds and stores ZPL per asset with progress, and prints over TCP 9100 with native Kotlin printer code.

**Tech Stack:** TypeScript + vitest + vite (kiosk/), Python 3 (fixture generator using api/src + kiosk_laptop/edge), Kotlin 2.0 / Compose / Room 2.6 / kotlinx.serialization / OkHttp / Robolectric (Android_Kiosk_App), androidx.javascriptengine.

**Spec:** `docs/superpowers/specs/2026-10-21-android-label-printing-design.md`

## Global Constraints

- **No change to the laptop kiosk or its edge generator**, and no change to the portal's existing label code or the server's generation. Python files are read, never edited.
- **No new API endpoints.** Use `/kiosk/sync/assets`, `/kiosk/sync/label-templates`, `/kiosk/labels/fonts`, `/kiosk/labels/fonts/{id}/content`, `/kiosk/scans`.
- Asset labels only. No container labels, no Bulk Print, no schema 3 (pictures), no Bluetooth printing (placeholder only), no iOS, no web kiosk changes.
- Labels the phone stores must be **byte-identical** to the laptop's for the same asset, template and DPI. Offsets and peel/tear are applied only at send time.
- Printed scans record `scan_type: "barcode"`, `scan_status: "labeled"` through the existing outbox; a reprint never records.
- Print path sends ZPL straight to the printer: no status checks or polling before/after a label. Peel mode = `^MMP` (the printer holds the next label), tear = `^MMT`.
- Template pick order (from `pick.py`): Top = destination (scope destination or both) → source → global (not "generic rack and ru") → generic; Front = destination → global; ties: highest `version`, then newest `updated_at` (string compare), first of equals wins.
- Outcome codes: `no_template_at_dpi`, `template_failed`, `template_unsupported`. User copy for them reuses `LABEL_REASONS` in `kiosk/src/lib/printQueue.ts` verbatim.
- Network printer constants (edge `printers.py`): port 9100, scan concurrency 64, connect timeout 500 ms, identify 1.5 s, query idle 2 s / total 5 s, send 30 s.
- Peeler query: `! U1 getvar "sensor.peeler_present"\r\n`, reply `"Present"`/`"Not Present"`. Font check: `^XA^HWE:*.*^XZ`. Font install: `~DYE:<NAME>,B,T,<len>,,` + bytes; resident font `TT0003M_.TTF` is never installed.
- American English in all copy, comments and docs.
- Kiosk TS: `npm --prefix kiosk test -- <files>`; `npm --prefix kiosk run build`. DOM tests start with `// @vitest-environment jsdom` (labelgen tests are node).
- Android: from `Android_Kiosk_App/`, `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ./gradlew testDebugUnitTest assembleDebug`; Robolectric `@Config(sdk=[34])`; `core/` stays Android-free (`CorePurityTest`).
- Every suite and build runs in the FOREGROUND with a 600000 ms timeout.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Porting rules (binding for Tasks 1–4)

1. **Python `round()`** is half-to-even on doubles: implement `pyRound(x)` and use it everywhere Python uses `round` (`zpl._dots`, text h/w incl. 1.2× and 1.15× bold, QR mag, `qr_fo_offset_dots`). Floor division `//` → `Math.floor` (negative operands occur in `_v2_qr`).
2. **Code points, not UTF-16 units**, for `max_chars`, `length_limits`, `rjust`, slicing and `_esc` (`^~_\` and anything outside 32..126 → `_xx` per UTF-8 byte, lowercase hex).
3. **Python `str()` of JSON values**: asset payloads are parsed by a number-preserving JSON reader (`pyjson.ts`); `pyStr` reproduces Python: `None→""` (in `_text`), `True/False→"Yes"/"No"` (in `_text`) and `"True"/"False"` (plain `str`), ints as digits, floats as Python `repr` (`12.0`, `1e+16`, `1e-05`), dicts/lists as Python repr.
4. **Decimal**: `ru_text` = `format(Decimal(t).normalize(), "f")` and `_format_ru` are done on decimal strings, never floats.
5. **Dates**: `fields` reads `move_day[:10]`; `label_values.move_dates` → `MM/DD/YYYY` and `DD-MON-YYYY` (uppercase English month).
6. **`max()` keeps the first of equal maxima**; string compare for `updated_at`.
7. Non-ZPL `language_key` (ESC/P, P-touch) → `template_unsupported` (Ruling: Android prints only to Zebras).

## Review Focus

1. **A From-To column holding a number** (`12.0`, `7`, `1e-05`) prints exactly what the laptop prints. → fixture cases in Task 4.
2. **Non-ASCII names and long values** (accents, CJK, emoji, `^` `~` `_`) truncate and escape identically. → fixture cases in Task 4.
3. **Upgrading a device with unsent scans in the outbox** keeps every queued scan and the synced move. → migration test in Task 5.
4. **Scanning an asset whose label isn't ready** (still generating, no template at this DPI, template too new) shows the reason and records nothing. → test in Task 9.
5. **The printer drops mid-print or is unreachable**: a clear error, Retry resends the same bytes, and the Labeled scan is recorded exactly once. → test in Task 9.

---

### Task 1: labelgen foundations (Python-compatible primitives and small modules)

**Files:**
- Create: `kiosk/src/labelgen/py.ts` (pyRound, floorDiv, codePoints/cpLength/cpSlice/rjust, pyStr, decimal-string normalize/format, date helpers)
- Create: `kiosk/src/labelgen/pyjson.ts` (number-preserving JSON parse: numbers become `PyNumber {kind: 'int'|'float', text}`)
- Create: `kiosk/src/labelgen/{tokens,tags,fonts,barcode,qr,fieldRules}.ts`
- Test: `kiosk/src/labelgen/py.test.ts`, `pyjson.test.ts`, `small.test.ts`

**Interfaces:**
- Produces: `pyRound(x: number): number`; `floorDiv(a: number, b: number): number`; `cpLength(s)`, `cpSlice(s, start, end?)`, `rjust(s, width, fill)`; `pyStr(v: PyValue): string`; `parsePyJson(text: string): PyValue`; `PyNumber`; `decimalNormalize(text): string | null` (null when not a finite decimal); `formatRu(text): string` (`_format_ru`); `moveDates(isoDay): [string, string]`; `TOKEN_RE`, `applyPlaceholders(code, values)`; `LABEL_TAG_*`, `resolveLabelTag`; `FAMILIES`, `DEFAULT_FAMILY`, `fontObject(family, weight): [string, boolean]`, `RESIDENT_FONT = 'TT0003M_.TTF'`; `code128Data(fd)`, `barcodeModules(sym, data)`; `qrModules(value)`, `qrFoOffsetDots(dpi)`, `QrTooLong`; `FieldRules`, `applyRules`, `isBlank`, `piece`, `splitValue`.
- Reuse portal twins (`portal/src/labels/fieldRules.ts`, `builder/barcode.ts`, `builder/qr.ts`) by import only if they are pure (no DOM/Intl) and pass the existing shared fixtures (`api/src/serversherpa/labels/fixtures/{field_rules,barcode_modules}.json`); otherwise port.

- [ ] **Step 1: Failing tests**: `pyRound(2.5)===2`, `pyRound(3.5)===4`, `pyRound(-2.5)===-2`, `pyRound(0.5)===0`; `floorDiv(-3,2)===-2`; `cpLength('a😀')===2`; `rjust('7',3,'0')==='007'`; `pyStr(parsePyJson('12.0'))==='12.0'`, `'7'→'7'`, `'1e-5'→'1e-05'`, `'1e16'→'1e+16'`, `'0.1'→'0.1'`, `'{"a":1}'→"{'a': 1}"`, `'true'→'True'`; `decimalNormalize('14.50')==='14.5'`, `('3.0')==='3'`, `('x')===null`; `formatRu('14.00')==='U14'`, `('14.50')==='14.5'`; `moveDates('2026-10-05')` → `['10/05/2026','05-OCT-2026']`; `applyPlaceholders('{a}-{zz}', {a:'1'})==='1-'`; field-rules and barcode fixture files all pass.
- [ ] **Step 2: Run; expect FAIL** (`npm --prefix kiosk test -- src/labelgen`).
- [ ] **Step 3: Implement**, each module mirroring its Python file (`api/src/serversherpa/labels/<name>.py`) function by function, with a header comment naming the Python source.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat(labelgen): Python-compatible primitives and small label modules`

### Task 2: labelgen model + ZPL compiler + render (schemas 1–2)

**Files:**
- Create: `kiosk/src/labelgen/{model,zpl,render}.ts`
- Test: `kiosk/src/labelgen/zpl.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `parseDesign(raw: unknown): Design` (throws `DesignError`; schema 3 parses but Task 3 routes it to unsupported); `elementValue`, `elementHidden`; `compileZpl(design: Design, dpi: number, substitutions?: Record<string,string>): string` (no images); `renderTemplate(t: {kind: 'code'|'design'; code: string|null; design: unknown; language_key: string}, values: Record<string,string>, opts: {width_in: number; height_in: number; dots: number}): {zpl: string; unknown: string[]}` (non-ZPL language → throws `UnsupportedLanguage`).
- Output format: `^XA\n^PW..\n^LL..\n^CI28` … lines joined by `\n`, ending `^XZ`, no trailing newline.

- [ ] **Step 1: Failing tests**: `compileZpl(parseDesign(vegas_v2.json), 300, MOCK_VALUES)` equals `fixtures/vegas_v2_300.zpl` minus its trailing `\n` (import the files from `api/src/serversherpa/labels/fixtures/`; `MOCK_VALUES` copied verbatim from `fields.py:87` into a test fixture); a schema 1 design with tokens compiles with substitutions; faux bold emits the second `^FT` one dot along the reading direction; inverted text emits `^GB` + `^FR`; a value with `^`, `~`, `_`, `é` is `^FH_`-escaped per Porting rule 2; `renderTemplate` with `language_key:'escp'` throws `UnsupportedLanguage`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** from `model.py` (schemas 1–2 element types, camelCase JSON keys, defaults), `zpl.py` (skip image code) and `render.py` (`code` → `applyPlaceholders`; design → parse with size overridden by `width_in`/`height_in`, compile at `dots`).
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat(labelgen): design model and ZPL compiler`

### Task 3: labelgen values, pick, plan and print helpers

**Files:**
- Create: `kiosk/src/labelgen/{labelValues,fields,pick,templateFonts,plan,printing,index}.ts`
- Test: `kiosk/src/labelgen/plan.test.ts`, `printing.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `pickTemplate(templates: TemplateChoice[], kind: 'top'|'front', dpiKey: string): [TemplateChoice|null, string[]]` (note text verbatim from `pick.py:72`).
  - `assetLabelValues(asset, move, catalogKeys, generationRules?)`, `fieldValues(payload: PyValue, context: PyValue): Record<string,string>`, `designFieldKeys(design)`, `MOCK_VALUES`, `mockFieldValues(labelType, keys)`.
  - `templateFonts(t: SyncTemplate): string[]` (design → `designFonts`, else `fontsUsed(code)`, uppercased).
  - `type LabelKind = 'top'|'front'`; `interface PlanInput { assetsJson: string /* raw /kiosk/sync/assets body */; templatesJson: string /* raw /kiosk/sync/label-templates body */; kind: LabelKind; dpi: number }`.
  - `interface Plan { templateId: string|null; templateFamily: string|null; notes: string[]; fonts: string[]; availableDpis: number[]; jobs: {assetId: string; fingerprint: string}[] }` — fingerprint parts exactly as edge `generate.py` (no-template / unsupported / normal), hashed with a deterministic non-crypto hash (cyrb53, hex).
  - `buildPlan(input: PlanInput): Plan`; `renderLabels(input: PlanInput, assetIds: string[]): {assetId: string; zpl: string|null; outcome: 'ok'|'no_template_at_dpi'|'template_failed'|'template_unsupported'; fingerprint: string}[]` (schema > 2 or non-ZPL → unsupported; design without positive width/height/dots → failed; any throw → failed).
  - `printing.ts`: `applyPrintSettings(zpl, {verticalOffset, horizontalOffset}, {singleCopy: true})`, `withPrintMode(zpl, peel)`, `alignmentTestZpl(widthDots, heightDots, sizeLabel, dpi)` — ported verbatim from `portal/src/lib/printLabels.ts` and `kiosk/src/lib/stationPrinter.ts` (no Intl/DOM imports), plus `sampleLabel(templatesJson, kind, dpi): {zpl: string|null; reason: string|null}` (the picked template rendered with `MOCK_VALUES`/`mockFieldValues`).
  - `index.ts`: the bundle surface `globalThis.labelgen = { version, buildPlan, renderLabels, sampleLabel, applyPrintSettings, withPrintMode, alignmentTestZpl }`, every function taking and returning **JSON strings** (args object in, result out).

- [ ] **Step 1: Failing tests**: pick order for top and front incl. DPI fall-through note text and first-of-equal tie; `buildPlan` with no matching template → every job fingerprinted `no_template`; schema 3 template → `template_unsupported`; schema 2 values restricted to placed keys + `ft:<header>`; schema 1 values from `assetLabelValues` with generation rules (position split, length limit); changing `kind` or `dpi` changes fingerprints; printing helpers equal the portal/kiosk originals on 5 sample inputs (import both in the test).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** per `label_values.py`, `fields.py`, `pick.py`, `template_fonts.py`, and the logic of `kiosk_laptop/edge/src/edge/labels/generate.py` (`_choice`, `template_schema`, `build_plan`, `render_job`) — store-free.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat(labelgen): template pick, label values, plan and print helpers`

### Task 4: Reference-label suite + the bundle

**Files:**
- Create: `kiosk/src/labelgen/fixtures/make_reference.py` (generator), `kiosk/src/labelgen/fixtures/reference.json` (generated, committed)
- Create: `kiosk/src/labelgen/reference.test.ts`, `kiosk/src/labelgen/bundle.test.ts`
- Create: `kiosk/vite.labelgen.config.ts`; script `"build:labelgen"` in `kiosk/package.json`
- Create (generated, committed): `Android_Kiosk_App/app/src/main/assets/labelgen.js`

**Interfaces:**
- Consumes: Task 3's `buildPlan`/`renderLabels`.
- Produces: `reference.json` = `{ source_hash: string, cases: [{ name, assetsJson, templatesJson, kind, dpi, expected: [{asset_id, zpl|null, error|null}] }] }`; the bundle at the Android assets path exposing `globalThis.labelgen`.

- [ ] **Step 1: Write the generator.** It seeds a temporary edge `Store` (like `kiosk_laptop/edge/tests/test_label_generate.py` `_put_cache`) with each case's assets and templates and calls the edge's real `build_plan` + `render_job`, so expected output comes from the laptop's own path. Run: `cd kiosk_laptop/edge && PYTHONPATH=../../api/src .venv/bin/python ../../kiosk/src/labelgen/fixtures/make_reference.py` (create the edge venv first if missing: `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`). `source_hash` = sha256 over the sorted contents of `api/src/serversherpa/labels/*.py` and `kiosk_laptop/edge/src/edge/labels/generate.py`.
  Cases (at least): builtin designs `VEGAS_DESTINATION`, `AMSTERDAM_DESTINATION`, `GENERIC_RACK_AND_RU`, `FRONT_ASSET_TAG`, `SWITCH_FRONT_TAG` (copy their dicts into the script if importing `builtin_templates` needs a DB; note it), the edge tests' `E2E_DESIGN` (schema 1) and a `code` template with tokens; both kinds; DPI 203 and 300 incl. fall-through; generation rules; field rules (split/pad/max/strip); QR and Code 128 edge values (empty, numeric-only, long, odd/even digits, `>`); non-ASCII/emoji/`^~_` names; `raw_ft` numbers `12.0`, `7`, `1e-05`, `true`, `null`; `source_ru_raw` `14.50`, `14.00`, `0.5`, `abc`; missing `label_context`; schema 3 template; an ESC/P template (expected: Ruling 7 → the TS side asserts `template_unsupported` for it instead of the edge output, documented in the case).
- [ ] **Step 2: Failing tests**: `reference.test.ts` runs every case through `buildPlan` + `renderLabels` and asserts each asset's ZPL is byte-identical (or the same outcome code); it also recomputes `source_hash` from the Python files (node `fs`) and fails with "Regenerate kiosk/src/labelgen/fixtures/reference.json (see make_reference.py)" when it differs. `bundle.test.ts` builds the bundle in memory (or reads the committed file), evaluates it in a fresh `vm` context with no DOM/Intl, calls `labelgen.renderLabels` through JSON strings for one case, and asserts the committed `Android_Kiosk_App/app/src/main/assets/labelgen.js` equals a fresh build (message: "run npm --prefix kiosk run build:labelgen").
- [ ] **Step 3: Generate fixtures; fix the TS port until every case passes** (never edit expected output; fix TS).
- [ ] **Step 4: Run labelgen tests + full kiosk suite + `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `test(labelgen): reference labels from the laptop's path; bundle for Android`

### Task 5: Android data — first Room migration, sync of templates/fonts/payloads with per-part progress

**Files:**
- Modify: `Android_Kiosk_App/app/build.gradle.kts` (Room schema export dir `app/schemas`), `data/db/KioskDatabase.kt` (version 2, `exportSchema = true`, `MIGRATION_1_2`), `data/db/Entities.kt`, `data/db/Daos.kt`
- Modify: `core/model/Sync.kt` (models), `data/api/KioskApi.kt` (+ `FakeKioskApi`), `data/sync/Sync.kt`
- Test: `data/db/MigrationTest.kt`, `data/sync/SyncLabelsTest.kt`

**Interfaces:**
- Produces:
  - `AssetEntity` gains `payloadJson: String` (the asset's raw JSON object text, as received); table `label_templates(id TEXT PK, json TEXT)`; table `label_fonts(id TEXT PK, name TEXT, size INT, resident INT, fileName TEXT?)` (font bytes saved under `filesDir/label-fonts/<id>.ttf`, never in Room); table `generated_labels(assetId TEXT PK, zpl TEXT?, outcome TEXT, fingerprint TEXT, templateId TEXT?)`; meta keys `label_context` (raw JSON) and `assets_raw` is NOT stored (generator input is rebuilt from `payloadJson` rows + context).
  - `KioskApi.labelTemplatesRaw(initiativeId): String`, `assetsSyncRaw(initiativeId): String` (raw bodies; existing typed decode reuses them), `labelFonts(initiativeId): KioskLabelFonts`, `labelFontContent(id, initiativeId): ByteArray`.
  - `SyncStatus` gains `parts: List<SyncPart>` with `SyncPart(name: String /* assets|people|containers|trucks|templates|fonts */, state: PartState /* WAITING, RUNNING, DONE, FAILED */, count: Int?)`.
  - Templates and fonts are soft steps: a failure keeps the previous rows and sets `SyncStatus.error`-free `labelsError: String?`.
- [ ] **Step 1: Failing tests**: `MigrationTest` (room-testing `MigrationTestHelper` with the exported v1 schema — export v1 first by building with `exportSchema = true` at version 1 and committing `schemas/.../1.json`, then add v2): a v1 DB with 2 outbox rows, 3 assets and the sync meta row migrates to v2 keeping all of them, `payloadJson` defaults to `'{}'`. `SyncLabelsTest` with `FakeKioskApi`: sync stores every asset's raw JSON text unchanged (a `raw_ft` value `12.0` survives as `12.0`), the `label_context`, all templates, font metadata, writes non-resident font files, and `parts` goes WAITING→RUNNING→DONE for each; a 500 on templates keeps the old templates and finishes the move sync.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Raw asset JSON: decode the assets body to `JsonObject` and store each element's `toString()` only if kotlinx preserves number literals (it keeps `JsonPrimitive.content`; verify `12.0` round-trips in the test) — otherwise slice the raw text.
- [ ] **Step 4: Run `./gradlew testDebugUnitTest assembleDebug`; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Room v2 migration; sync label templates, fonts and full asset payloads with progress`

### Task 6: Android label generation (JavaScriptEngine) with progress

**Files:**
- Modify: `gradle/libs.versions.toml`, `app/build.gradle.kts` (add `androidx.javascriptengine:javascriptengine`, a stable release)
- Create: `data/labels/LabelGenerator.kt` (JS sandbox wrapper), `data/labels/LabelBuilder.kt` (plan → changed jobs → batched render → store, progress), `core/labels/LabelBuildStatus.kt`
- Test: `data/labels/LabelBuilderTest.kt` (with a fake `LabelEngine`), `core/labels/LabelBuildStatusTest.kt`

**Interfaces:**
- Consumes: Task 4 bundle (`assets/labelgen.js`), Task 5 tables, Task 8's settings (kind, printer DPI) via `LabelSettings` — define the read interface here: `interface LabelSettingsSource { val settings: Flow<LabelSettings> }`, `data class LabelSettings(kind: LabelKind = TOP, printer: SavedPrinter? = null, offsetX: Int = 0, offsetY: Int = 0, peel: Boolean = false)`, `data class SavedPrinter(host: String, model: String, serial: String, dpi: Int)`.
- Produces: `interface LabelEngine { suspend fun call(fn: String, argsJson: String): String }` (`LabelGenerator` implements it with `JavaScriptSandbox`, `isSupported()` check); `LabelBuilder.status: StateFlow<LabelBuildStatus>` with `LabelBuildStatus(phase: IDLE|RUNNING|DONE|UNSUPPORTED_DEVICE|ERROR, done: Int, total: Int, ready: Int, problems: Map<String /*outcome*/, Int>, notes: List<String>)`; `LabelBuilder.rebuild(reason: String)`; triggers: after a sync completes, a setup save (kind) and a printer save whose DPI differs. Batches of 200 assets per `renderLabels` call (and use `EVALUATE_WITHOUT_TRANSACTION_LIMIT` when the sandbox supports it). Only jobs whose fingerprint differs from `generated_labels` re-render; rows for assets no longer on the move are deleted.
- [ ] **Step 1: Failing tests** (fake engine): first build renders all, stores ZPL/outcome/fingerprint, progress reaches `done == total`; second build with unchanged inputs renders nothing; a kind change re-renders all; no printer saved → phase DONE with 0 total and status says a printer is needed; `UNSUPPORTED_DEVICE` when the engine reports unsupported; a batch throwing marks phase ERROR and keeps earlier stored labels.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Gradle tests + assemble; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): on-device label generation with progress`

### Task 7: Android Zebra network printer core

**Files:**
- Create: `core/printer/ZebraReplies.kt` (pure parsers: host identification, host status, directory, getvar), `core/printer/PrinterChecks.kt` (status problems, missing fonts, `fontFixFor`)
- Create: `data/printer/NetworkZebra.kt` (socket send/query with the Global Constraints timeouts, font install), `data/printer/ZebraScanner.kt` (subnet scan)
- Test: `core/printer/ZebraRepliesTest.kt` (fixtures: `kiosk_laptop/edge/tests/fixtures/zt220_hh.txt` and replies copied from `portal/src/labels/zebraUsb.test.ts`), `data/printer/NetworkZebraTest.kt` (local `ServerSocket` fake printer)

**Interfaces:**
- Produces: `parseHostIdentification(text): HostId?(model, firmware, dotsPerMm, memory, dpi)` (dpi from dots/mm: 6→150, 8→203, 12→300, 24→600), `parseHostStatus(text): HostStatus?`, `parseDirectory(text): List<String>` (uppercased object names), `parseGetvar(text): String?`; `statusProblems(HostStatus): List<String>`; `fontFixFor(missing: List<String>, library: List<LabelFont>): FontFix(installable, builtIn, notInLibrary)`; `class NetworkZebra(host: String, port: Int = 9100) { suspend fun identify(): HostId; suspend fun status(): HostStatus; suspend fun peelerPresent(): Boolean?; suspend fun fonts(): List<String>; suspend fun send(zpl: String); suspend fun installFont(name: String, bytes: ByteArray) }`; `class ZebraScanner { suspend fun scan(): List<FoundPrinter(host, model, serial, dpi)> }` — scans the device's Wi-Fi/Ethernet IPv4 /24 (from `ConnectivityManager` link properties), probing 9100 with concurrency 64 and identifying responders with `~HI`, finishing within ~10 s.
- [ ] **Step 1: Failing tests**: parsers on the ZT220 sample and the portal's sample replies (exact model/dpi/status fields); `fontFixFor` splits resident/installable/missing; `NetworkZebra` against a local fake printer: `send` delivers exact bytes; `identify` parses the fake's `~HI` reply; `installFont` sends `~DYE:NAME,B,T,<len>,,` then the bytes; a closed port → `PrinterUnreachable`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** (port parsers from `portal/src/labels/zebraUsb.ts`; Dispatchers.IO; no Android imports in `core/`).
- [ ] **Step 4: Run Gradle tests + assemble; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Zebra network printer core (query, send, fonts, subnet scan)`

### Task 8: Android setup step (Top/Front) and label settings storage

**Files:**
- Modify: `ui/screens/setup/KioskSetupViewModel.kt`, `KioskSetupScreen.kt` (step 4), `core/model/Kiosk.kt` (`KioskSetupSelection.labelKind: String = "top"`), `data/prefs/KioskPrefs.kt` (key `ss.kiosk.labels` JSON for `LabelSettings` minus kind; kind lives in the setup selection)
- Create: `data/labels/LabelSettingsStore.kt` implementing Task 6's `LabelSettingsSource` + setters
- Test: `KioskSetupViewModelTest` additions, `LabelSettingsStoreTest`

**Interfaces:**
- Produces: setup header `STEP n OF 4`; step 4 title **"What do labels print on?"** with cards **Top** (`Labels for the top of the device.`) and **Front** (`Labels for the front of the device.`), Top preselected; tapping a card finishes setup (the existing `finish` path moves from step 3 to step 4). `LabelSettingsStore.setPrinter(SavedPrinter?)`, `setOffsets(x, y)`, `setPeel(Boolean)`.
- [ ] **Step 1: Failing tests**: scan type now advances to step 4; finishing on Front saves `labelKind = "front"` and triggers `LabelBuilder.rebuild("setup")`; a selection saved before this change reads as `top`; settings store round-trips printer/offsets/peel.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Gradle tests + assemble; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Top/Front setup step and label settings`

### Task 9: Android Label Printing — Print Labels screen

**Files:**
- Modify: `core/features/Features.kt` (LABELS: not a placeholder; blurb `Print asset labels.`), `FeaturesTest`, `ui/KioskApp.kt` (routes `labels`, `labels/print`, `labels/printer`)
- Create: `ui/screens/labels/LabelsHomeScreen.kt` (two cards: **Print Labels**, **Printer Setup**), `ui/screens/labels/PrintLabelsScreen.kt` + `PrintLabelsViewModel.kt`, `core/labels/PrintQueue.kt` (pure state machine: job → sending → printed/failed, recorded flag)
- Test: `core/labels/PrintQueueTest.kt`, `ui/screens/labels/PrintLabelsViewModelTest.kt`

**Interfaces:**
- Consumes: Task 5 (`generated_labels`, assets), Task 6 (`LabelBuilder.status`, `LabelEngine` for `applyPrintSettings`/`withPrintMode`), Task 7 (`NetworkZebra.send`), Task 8 (settings), existing `Outbox.enqueue(EnqueueInput(scannedValue, "barcode", asset, siteId, initiativeId, scanStatus = "labeled"))`, `ScanBus`, `matchScan` (asset ID or serial).
- Behavior: collect `ScanBus` in a screen-level `LaunchedEffect`; a match with `outcome == ok` → send `withPrintMode(applyPrintSettings(zpl, offsets, singleCopy), peel)` → on success enqueue one Labeled scan; **Reprint** on a printed row resends without recording; **Retry** on a failed row resends the same bytes and records once on success. Messages: `No printer set up. Open Printer Setup.`; `No asset matches that scan.`; the `LABEL_REASONS` texts for the three outcomes; `Labels are still being made (n of N).`; `Can't reach the printer at <host>.`. Header shows ready count and a problems summary (outcome → count) and the build progress bar while RUNNING; `UNSUPPORTED_DEVICE` → `This device can't make labels (its system WebView is too old).`
- [ ] **Step 1: Failing tests**: PrintQueue — success records once; failure then Retry success records once; Reprint never records; scan of an asset with `no_template_at_dpi` shows the reason and records nothing; scan while RUNNING and the asset has no row yet → "still being made"; printer unreachable → error and nothing recorded.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** with the app's existing Compose idioms (portal tokens, `SetupCard`-style cards, scan list rows).
- [ ] **Step 4: Run Gradle tests + assemble; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Print Labels — scan to print, Labeled scans, reprint and retry`

### Task 10: Android Label Printing — Printer Setup screen

**Files:**
- Create: `ui/screens/labels/PrinterSetupScreen.kt` + `PrinterSetupViewModel.kt`, `ui/screens/labels/TestLabelSheet.kt`
- Test: `ui/screens/labels/PrinterSetupViewModelTest.kt`

**Interfaces:**
- Consumes: Task 7 (scanner, NetworkZebra, parsers, `fontFixFor`), Task 5 (font metadata/files), Task 6 (`LabelEngine` for `alignmentTestZpl`, `sampleLabel`; `LabelBuilder.rebuild("printer")` when DPI changes; plan `fonts`), Task 8 (settings).
- Behavior:
  - **Choose printer:** **Scan network** (list of found Zebras: model, serial, DPI, IP), **Enter IP** (validates IPv4, identifies with `~HI`), **Bluetooth — coming soon** (disabled card). Saving stores `SavedPrinter`.
  - **Checks** (run on save and on **Check again**): answers (`~HI`), DPI vs the plan's `availableDpis` (warn when no template at this DPI, with the pick note text), status (`~HS` problems), peeler (`Present`/`Not Present`/unknown), fonts (needed = plan `fonts`; installed = `^HWE:*.*`; missing → **Install missing fonts** from synced files, then recheck after 500 ms).
  - **Test labels:** **Alignment label** (`alignmentTestZpl` at the printer's DPI and the picked template's size) and **Sample label** (`sampleLabel`), both sent with current offsets and print mode.
  - **Offsets** (top, left; dots; −9999…9999) and **Peel / Tear** toggle (Peel disabled with a note when the peeler check says `Not Present`), saved immediately; never trigger a rebuild.
- [ ] **Step 1: Failing tests** (fakes): scan lists found printers and saving one with a new DPI triggers a rebuild; manual IP that doesn't answer shows `No Zebra printer answered at <ip>.`; fonts check lists missing and install sends each installable font then rechecks clean; peel toggle disabled when not present; test labels send the expected ZPL (offsets applied, `^MMP`/`^MMT`).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Gradle tests + assemble; expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Printer Setup — find printers, checks, fonts, test labels, offsets, peel`

### Task 11: Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (append `## Implementation notes`), `Android_Kiosk_App/README.md` (how the bundle is built/updated; regenerate reference labels)

- [ ] **Step 1:** Record rulings from the ledger, the bundle/reference workflow, and anything that diverged.
- [ ] **Step 2: Commit** `docs(android): label printing implementation notes`

---

## After the tasks (controller)

1. Whole-branch review; one fix wave; scoped re-review.
2. Gates: labelgen + full kiosk suite + kiosk build; Android `testDebugUnitTest assembleDebug`; reference fixtures regenerate with no diff.
3. Live test: emulator (`Medium_Phone_API_36.0`) against the dev API on a cloned DB: sign in, setup with Top, sync progress incl. templates/fonts, label build progress, Printer Setup against a fake ZPL listener on the Mac (`nc -l 9100` style capture) and read-only `~HI`/`~HS`/`^HW` against the ZD421 at 10.10.48.67; print by scan; compare one captured label byte-for-byte with the laptop's stored label for the same asset/template/DPI.
4. Report to Jimmy.
