# Web Kiosk Label Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web kiosk's Printing Station prints asset labels by scan over a USB Zebra, with labels generated in the browser by the shared `labelgen` generator.

**Architecture:** Sync keeps the raw assets/templates bodies; a Web Worker builds every asset's ZPL into IndexedDB when settings or data change; one `LabelBackend` seam lets the laptop's existing Printing Station, printer step, test-label modal and station printer tools run on either the laptop edge (unchanged) or the web kiosk's local store.

**Tech Stack:** `kiosk/` Vite 5 + React 18 + TypeScript, vitest 3 (`// @vitest-environment jsdom` for DOM tests), IndexedDB (`lib/localDb.ts`), WebUSB (`lib/useZebraPrinter.ts`), `kiosk/src/labelgen`.

**Spec:** `docs/superpowers/specs/2026-11-04-web-kiosk-label-printing-design.md`

## Global Constraints

- Laptop behavior must not change. Every existing laptop test (`PrintingStation.test.tsx`, `PrinterStep.test.tsx`, `TestLabelModal.test.tsx`, `StationPrinterTools.test.tsx`, `useStationPrinter.test.ts`, `printQueue.test.ts`, `KioskSetup*.test.tsx`, `LabelRegenScreen.test.tsx`) passes **without edits to its assertions**. Mock targets may move only if a test's import path must change.
- No status check, poll or wait in the per-label print path. Labels go straight to the printer.
- Web printing is USB only (WebUSB). The web kiosk never calls an `/edge/*` route.
- Labels must be byte-identical to `kiosk/src/labelgen/fixtures/reference.json` for the same inputs.
- `kiosk/src/labelgen/index.ts` (the Android/iOS bundle entry) must not import anything new; `npm --prefix kiosk run build:labelgen` output must stay unchanged (bundle freshness test).
- American English in all copy and comments. Copy that says "this laptop" on the laptop says "this kiosk" on the web.
- Scan recorded for a printed label: `scan_type: 'barcode'`, `scan_status: 'labeled'`, the exact scanned value; never on Reprint.
- Run all test commands in the foreground with a 600000 ms timeout; never background a suite.
- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/web-kiosk-labels` on branch `web-kiosk-labels`. Commit after each task. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Move switch: a kiosk re-set-up on move B must never print a label built for move A (stored labels and raw bodies carry `initiativeId`; a mismatch is "no move data", not a print).
2. A scan during a sync or a label build is refused with a message, never printed from data the sync is replacing.
3. Changing Top/Front in Kiosk Setup, or saving a printer with a different DPI, rebuilds and the next print uses the new kind/DPI.
4. Clear local data while a printer is saved: labels and raw bodies are gone, no build starts until the next sync, and the station says there is no move data.
5. Offline printing: labels still print; the Labeled scan sits in the outbox and the row reads "Printed" until the outbox row is `accepted`, then "Printed + Recorded".

Each has a test in the owning task below.

---

### Task 1: Sync keeps the raw bodies (IndexedDB v7)

**Files:**
- Modify: `kiosk/src/lib/api.ts` (fetch helpers), `kiosk/src/lib/localDb.ts`, `kiosk/src/lib/sync.ts`
- Test: `kiosk/src/lib/sync.test.ts`, `kiosk/src/lib/localDb.test.ts`

**Interfaces:**
- Produces:
  - `fetchAssetsSyncRaw(initiativeId: string): Promise<{ body: KioskAssetsSync; text: string }>` and `fetchLabelTemplatesSyncRaw(initiativeId: string): Promise<{ body: KioskLabelTemplatesSync; text: string }>` in `api.ts` (same URL and same `ApiError` mapping as the existing fetchers; `body = JSON.parse(text)`).
  - `DB_VERSION = 7`; new `StoreName`s `'assets_raw' | 'label_templates_raw' | 'labels'`, each `keyPath: 'key'` except `labels` (`keyPath: 'asset_id'`). All three are in `STORES` (so Clear local data empties them).
  - Raw row shape: `export interface RawBodyRow { key: 'body'; initiativeId: string; text: string }`.
  - `readRawBody(store: 'assets_raw' | 'label_templates_raw'): Promise<RawBodyRow | null>` in `localDb.ts`.

- [ ] **Step 1: Write the failing tests** in `sync.test.ts`:
  - `stores the raw assets body in the same transaction as the assets` — after `runSync('m1','Move 1')` with a mocked `fetchAssetsSyncRaw` returning `text: '{"initiative_id":"m1","assets":[{"id":"a1","x":2.0}]}'`, `readRawBody('assets_raw')` equals `{ key: 'body', initiativeId: 'm1', text: <that exact text> }` (the `2.0` survives as text).
  - `stores the raw templates body with the template rows`.
  - `a failed templates download on the same move keeps the previous raw templates body`.
  - `a failed templates download on a different move clears the raw templates body` (and the `label_templates` rows, as today).
  - In `localDb.test.ts`: `clearing local data empties assets_raw, label_templates_raw and labels`.
- [ ] **Step 2: Run** `npx vitest run src/lib/sync.test.ts src/lib/localDb.test.ts` from `kiosk/` — expect FAIL.
- [ ] **Step 3: Implement.** Bump to v7 with the three stores in `onupgradeneeded`. `runSync` uses `fetchAssetsSyncRaw` and adds `{ store: 'assets_raw', rows: [rawRow] }` to its existing `replaceAllMulti`; `syncLabelTemplates` uses `fetchLabelTemplatesSyncRaw` and writes `label_templates_raw` beside `label_templates` in its existing calls (the clear-on-move-change branch clears both). Keep the old `fetchAssetsSync`/`fetchLabelTemplatesSync` exports if anything else imports them.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/lib` — expect PASS.
- [ ] **Step 5: Commit** `feat(kiosk): sync keeps the raw assets and template bodies for the label generator`.

### Task 2: Web label settings and the Top/Front step in web Kiosk Setup

**Files:**
- Create: `kiosk/src/lib/webLabelSettings.ts`, `kiosk/src/lib/webLabelSettings.test.ts`
- Modify: `kiosk/src/pages/KioskSetup.tsx`
- Test: `kiosk/src/pages/KioskSetup.test.tsx` (add cases)

**Interfaces:**
- Produces (`webLabelSettings.ts`, localStorage key `ss.kiosk.labelPrinting`, every read/write in try/catch):
  - `readWebLabelKind(): LabelKind` — default `'top'`.
  - `writeWebLabelKind(kind: LabelKind): void`.
  - `readWebLabelSettings(): LabelStationSettings | null` — non-null only when a printer and a positive integer `dpi` are saved; `printer.type` is always `'usb'`, `printer.ip` always `null`; `label_kind` is `readWebLabelKind()`.
  - `writeWebLabelSettings(s: LabelStationSettings): LabelStationSettings` — stores it (forcing `type: 'usb'`, `ip: null`, integer offsets), writes `label_kind` too, returns what was stored.
  - `subscribeWebLabelSettings(fn: () => void): () => void` and `useWebLabelSettings(): LabelStationSettings | null` (`useSyncExternalStore`, like `useKioskSetup`).

- [ ] **Step 1: Write failing tests** in `webLabelSettings.test.ts`: default kind is `'top'`; `readWebLabelSettings()` is null with only a kind saved; a written network printer comes back as `{type:'usb', ip:null}`; a garbage stored value reads as null/`'top'` without throwing; subscribers fire on each write.
- [ ] **Step 2: Write failing tests** in `KioskSetup.test.tsx` (web mode, `isLaptop()` false):
  - `web setup asks what it prints after the scan type` — after tapping a scan type, the "What it prints" step shows with Top selected (`aria-selected="true"`), and the portal save (`submitKioskSetup`) has already been called once.
  - `choosing Front saves it on this kiosk and closes the wizard` — `readWebLabelKind()` is `'front'`, the summary shows.
  - `Back from What it prints returns to the scan type step`.
  - Laptop-mode tests stay as they are.
- [ ] **Step 3: Run** `npx vitest run src/lib/webLabelSettings.test.ts src/pages/KioskSetup.test.tsx` — expect FAIL.
- [ ] **Step 4: Implement.** `pathFor(false, …)` returns `['move','site','scan','kind']`. In `finish()`, web mode goes to `'kind'` (preselected `readWebLabelKind()`) instead of closing; the existing `LabelKindStep` `onChoose` on web calls `writeWebLabelKind(kind)` and closes the wizard (laptop keeps going to `'printer'`). Setup state is still written `complete` at the portal save, as today.
- [ ] **Step 5: Run** the two files plus `npx vitest run src/pages` — expect PASS.
- [ ] **Step 6: Commit** `feat(kiosk): web Kiosk Setup asks Top or Front; label settings kept on the kiosk`.

### Task 3: The in-browser label build (worker, store, status)

**Files:**
- Create: `kiosk/src/labelgen/sourceHash.ts`, `kiosk/src/lib/webLabels/buildCore.ts`, `kiosk/src/lib/webLabels/buildCore.test.ts`, `kiosk/src/lib/webLabels/worker.ts`, `kiosk/src/lib/webLabels/labelBuild.ts`, `kiosk/src/lib/webLabels/labelBuild.test.ts`
- Modify: `kiosk/src/labelgen/fixtures/make_reference.py` (also writes `sourceHash.ts`), `kiosk/src/labelgen/reference.test.ts` (one assertion), `kiosk/src/main.tsx`

**Interfaces:**
- Consumes: Task 1 `readRawBody`, `'labels'` store; Task 2 `readWebLabelSettings`, `subscribeWebLabelSettings`; `labelgen` `buildPlan`, `renderLabels`, `fingerprint`, `Plan`, `RenderResult`; `sync.ts` `subscribeSyncStatus`/`readSyncStatus`; `readKioskSetup`.
- Produces:
  - `export const SOURCE_HASH: string` in `labelgen/sourceHash.ts` (NOT imported by `labelgen/index.ts`).
  - `buildCore.ts`: `export function buildLabelSet(input: PlanInput, previous: ReadonlyMap<string, string>, onProgress?: (done: number, total: number) => void, batchSize = 500): { plan: Plan; rendered: RenderResult[]; removed: string[] }` — `rendered` holds only jobs whose fingerprint differs from `previous` (asset id → fingerprint); `removed` lists `previous` ids not in `plan.jobs`, and is `[]` when `plan.hasAssetData` is false. Also `export function planOnly(input: PlanInput): Plan` (= `buildPlan`).
  - Stored label row: `export interface WebLabelRow { asset_id: string; zpl: string | null; error: string | null; fingerprint: string; template_name: string; dpi: number; label_kind: LabelKind; initiativeId: string }` (`error` is the outcome when not `'ok'`).
  - Meta row key `'labels'`: `{ initiativeId, kind, dpi, sourceHash, assetsHash, templatesHash, total, ready, errors, unsupported, problems: Record<string, number>, notes: string[], templateName: string | null, builtAt }` where the hashes are `fingerprint([text])`.
  - `labelBuild.ts`:
    - `export type WebLabelStatus = LabelRunStatus & { error?: string }` (reuses the edge's `LabelRunStatus` shape: `state`, `reason`, `total`, `done`, `ready`, `errors`, `unsupported`).
    - `readWebLabelStatus(): WebLabelStatus`, `subscribeWebLabelStatus(fn): () => void`, `useWebLabelStatus(): WebLabelStatus`.
    - `requestLabelBuild(): Promise<void>` — no-op unless web settings exist, a setup move exists, and both raw bodies belong to that move; skips when the stored meta's `(initiativeId, kind, dpi, SOURCE_HASH, assetsHash, templatesHash)` all match; a newer request supersedes a running one (terminate the worker, start over).
    - `requestLabelPlan(opts: { dpi: number; kind: LabelKind }): Promise<Plan | null>` — `planOnly` on the stored bodies through the same runner; null without both bodies.
    - `installLabelBuild(): () => void` — web only: subscribes to web settings and to the sync status (a transition to `'done'`), calls `requestLabelBuild()` on install and on each; returns an uninstaller.
    - `setLabelBuildRunner(r: LabelBuildRunner | null): void` — test seam; default is a module Web Worker (`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`), falling back to running `buildCore` in-thread when `Worker` is undefined (jsdom).

- [ ] **Step 1: Write failing tests** in `buildCore.test.ts`:
  - `renders every job byte-identical to the reference fixture` — for one top and one front case from `fixtures/reference.json`, `buildLabelSet(case input, new Map())` yields the fixture's ZPL for each asset.
  - `re-renders only assets whose fingerprint changed` — second call with the first call's fingerprints renders `[]`; after editing one asset's value in the raw text, renders exactly that asset.
  - `lists removed assets but never prunes without asset data`.
  - `reports progress up to the job count`.
- [ ] **Step 2: Write failing tests** in `labelBuild.test.ts` (in-thread runner, fake-indexeddb as the other localDb tests do):
  - `builds and stores labels once settings, move and raw bodies exist`; status goes `running` → `idle` with `ready`/`errors` counts; `reason` is `'setup'` on the first build for a move, `'updates'` after.
  - `skips a build when nothing in its key changed`.
  - `a kind change rebuilds every label with the new kind` (Review Focus 3).
  - `a DPI change from saved settings rebuilds` (Review Focus 3).
  - `raw bodies for another move build nothing and leave status idle` (Review Focus 1).
  - `after Clear local data no build runs and no rows exist` (Review Focus 4).
  - `a sync finishing triggers a build`.
  - In `reference.test.ts`, add `expect(SOURCE_HASH).toBe(REFERENCE.source_hash)`.
- [ ] **Step 3: Run** `npx vitest run src/lib/webLabels src/labelgen/reference.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** `sourceHash.ts` (value copied from `reference.json`), the `make_reference.py` addition, `buildCore.ts`, `worker.ts` (message protocol: in `{type:'build'|'plan', id, input, previous?}`; out `{type:'progress', id, done, total}` | `{type:'result', id, …}` | `{type:'error', id, message}`), and `labelBuild.ts`. Write `labels` rows (put changed, delete removed) and the meta row in one transaction at the end. Template name comes from the stored template whose id is `plan.templateId`. Call `installLabelBuild()` from `main.tsx` when `!isLaptop()`.
- [ ] **Step 5: Run** step 3's command and `npx vitest run src/labelgen` — expect PASS (bundle freshness included).
- [ ] **Step 6: Commit** `feat(kiosk): build the move's labels in the browser with the shared generator`.

### Task 4: The label backend seam

**Files:**
- Create: `kiosk/src/lib/labelBackend.ts`, `kiosk/src/lib/labelBackend.test.ts`
- Modify: `kiosk/src/lib/printQueue.ts` (job carries the asset; copy by device word)
- Test: `kiosk/src/lib/printQueue.test.ts` (add cases only)

**Interfaces:**
- Consumes: edge functions in `api.ts` (`getLabelStation`, `putLabelStation`, `getLabelPlan`, `getStationLabel`, `postLabelPrinted`, `getRecordedScans`, `getLabelRunStatus`); Task 2 settings; Task 3 `readWebLabelStatus`, `requestLabelPlan`, `'labels'` store and meta; `outbox.ts` `enqueueScan`, `readOutbox`; `sync.ts` `readSyncStatus`; `readKioskSetup`.
- Produces:
  ```ts
  export interface LabelBackend {
    kind: 'edge' | 'web';
    deviceWord: 'laptop' | 'kiosk';
    printerTypes: readonly ('usb' | 'network')[];
    getSettings(): Promise<LabelStationSettings | null>;
    saveSettings(s: LabelStationSettings): Promise<LabelStationSettings>;
    getPlan(opts: { dpi?: number; kind?: LabelKind }): Promise<LabelPlan>;
    getLabel(assetId: string): Promise<StationLabel>;
    recordPrinted(job: PrintedJob): Promise<string | null>;
    recordedIds(ids: string[]): Promise<string[]>;
    getStatus(): Promise<LabelRunStatus>;
  }
  export const edgeLabelBackend: LabelBackend;   // thin pass-through to today's api.ts calls
  export const webLabelBackend: LabelBackend;
  export function labelBackend(): LabelBackend;  // isLaptop() ? edge : web
  ```
  - `printQueue.ts`: `PrintedJob` becomes `{ asset: PrintAsset; assetId: string; scannedValue: string; scannedAt: string }`; `PrintQueueDeps` gains optional `deviceWord?: 'laptop' | 'kiosk'` (default `'laptop'`); `export function needsUpdateText(word: 'laptop' | 'kiosk'): string` (`'This laptop needs an update to print this template.'` / `'This kiosk needs an update to print this template.'`); `NEEDS_UPDATE_TEXT` stays exported as the laptop string. New `SYNCING_TEXT = 'This kiosk is syncing. Labels will be ready shortly.'` for ApiError code `labels_syncing`.
  - Web `getLabel`: throws `ApiError(409, 'labels_syncing')` while the sync phase is `running`; `ApiError(409, 'labels_regenerating')` while the web build is `running`; `ApiError(404, 'label_not_found')` when there is no row, or the row's `initiativeId`/`label_kind`/`dpi` don't match the setup move and saved settings; else a `StationLabel` from the row.
  - Web `getPlan`: `requestLabelPlan` mapped to `LabelPlan` (`template` from the plan's picked template: id, name, family, dpi_key, version; `notes`; `fonts`; `available_dpis` as strings). Missing bodies → `{ template: null, notes: [], fonts: [], available_dpis: [] }`.
  - Web `recordPrinted`: `enqueueScan({ scanned_value, scan_type: 'barcode', asset: <OutboxAsset from job.asset>, site_id, initiative_id from readKioskSetup(), scan_status: 'labeled' })` → the row's `client_scan_id`.
  - Web `recordedIds`: ids whose outbox row status is `'accepted'`.
  - Web `getStatus`: `readWebLabelStatus()`.
  - Web `printerTypes`: `['usb']`; edge: `['usb', 'network']`.

- [ ] **Step 1: Write failing tests** in `labelBackend.test.ts`:
  - `web getLabel refuses while syncing` (code `labels_syncing`) and `while building` (code `labels_regenerating`) (Review Focus 2).
  - `web getLabel refuses a row built for another move` (`label_not_found`) (Review Focus 1).
  - `web recordPrinted queues a Labeled barcode scan with the exact scanned value`.
  - `web recordedIds returns only accepted rows` (Review Focus 5).
  - `web saveSettings forces USB and returns what was stored`.
  - `edge backend calls the edge functions` (mock `./api`; one assertion per method).
- [ ] **Step 2: Add failing cases** to `printQueue.test.ts`: `recordPrinted receives the asset`; `deviceWord kiosk says "This kiosk needs an update…" for template_unsupported`; `labels_syncing reads as the syncing message`.
- [ ] **Step 3: Run** `npx vitest run src/lib/labelBackend.test.ts src/lib/printQueue.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** both files.
- [ ] **Step 5: Run** the same plus `npx vitest run src/lib` — expect PASS (existing printQueue cases unchanged).
- [ ] **Step 6: Commit** `feat(kiosk): one label backend for the laptop edge and the web kiosk`.

### Task 5: Shared printer screens run on the backend

**Files:**
- Modify: `kiosk/src/lib/useStationPrinter.ts`, `kiosk/src/components/setup/PrinterStep.tsx`, `kiosk/src/components/setup/TestLabelModal.tsx`, `kiosk/src/pages/StationPrinterTools.tsx`, `kiosk/src/components/LabelRegenScreen.tsx`
- Test: add web cases to `useStationPrinter.test.ts`, `PrinterStep.test.tsx`, `TestLabelModal.test.tsx`, `StationPrinterTools.test.tsx`, `LabelRegenScreen.test.tsx`

**Interfaces:**
- Consumes: Task 4 `labelBackend()`; Task 2 `subscribeWebLabelSettings`; Task 3 `readWebLabelStatus`.
- Produces:
  - `useStationPrinter()` unchanged signature; settings come from `labelBackend().getSettings()`; on the web it also reloads when web settings change.
  - `PrinterStep` unchanged props; plan via `backend.getPlan`, save via `backend.saveSettings`; with one printer type (web) it skips the type cards and opens on USB; copy naming "this laptop" uses `backend.deviceWord`.
  - `TestLabelModal`: plan via `backend.getPlan`.
  - `StationPrinterTools`: offsets saved via `backend.saveSettings`; copy by device word.
  - `LabelRegenScreen` gains optional prop `getStatus?: () => Promise<LabelRunStatus>` (default `getLabelRunStatus`).

- [ ] **Step 1: Write failing web-mode tests** (mock `platform` so `isLaptop()` is false):
  - `PrinterStep on the web shows no network option and opens on USB`.
  - `PrinterStep on the web saves to this kiosk, not the edge` — `putLabelStation` not called; `readWebLabelSettings()` holds the printer, DPI, offsets and peel.
  - `PrinterStep on the web reads the DPI check from the local plan`.
  - `TestLabelModal on the web picks its sample template from the local plan`.
  - `StationPrinterTools on the web saves offsets to this kiosk`.
  - `useStationPrinter on the web reads saved web settings and reloads when they change`.
  - `LabelRegenScreen uses the getStatus it is given`.
- [ ] **Step 2: Run** `npx vitest run src/lib/useStationPrinter.test.ts src/components/setup src/pages/StationPrinterTools.test.tsx src/components/LabelRegenScreen.test.tsx` — expect FAIL on the new cases only.
- [ ] **Step 3: Implement** the switches to the backend.
- [ ] **Step 4: Run** step 2's command — expect PASS, every existing laptop case included unmodified.
- [ ] **Step 5: Commit** `feat(kiosk): printer setup, test labels and printer tools run on the web kiosk`.

### Task 6: Web Printing Station, Printer Setup page, routing, takeover

**Files:**
- Modify: `kiosk/src/App.tsx` (`LabelSectionRoute`), `kiosk/src/pages/PrinterTools.tsx`, `kiosk/src/pages/PrintingStation.tsx`, `kiosk/src/layout/KioskShell.tsx`, `kiosk/src/lib/features.ts` (Label Printing tile description says asset labels)
- Test: add web cases to `PrintingStation.test.tsx`, `PrinterTools.test.tsx`, `KioskShell.test.tsx`, `App`-level routing test where `LabelSectionPage.test.tsx`/`Labels.test.tsx` cover routes

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: web `/labels/station` = `PrintingStation`; web `/labels/printers` = `StationPrinterTools` when `readWebLabelSettings()` is non-null, else `PrinterStep` (USB, `initiativeId`/`labelKind` from setup and `readWebLabelKind()`), else the existing `UsbPrinterTools` when `navigator.usb` is missing. `/labels/bulk` stays the placeholder.

- [ ] **Step 1: Write failing web-mode tests:**
  - `PrintingStation`: `prints a scanned asset's stored label to the USB printer with offsets and print mode` (fake `StationPrinter.send` receives `withPrintMode(applyPrintSettings(zpl, …, {singleCopy:true}), peel)`); `records a Labeled scan in the outbox, never on Reprint`; `row reads Printed + Recorded once the outbox row is accepted` (Review Focus 5); `a scan while syncing shows the syncing message and prints nothing` (Review Focus 2); `header shows labels ready and how many couldn't be made, by reason`; `with no printer saved, the first visit opens Printer Setup`; `coming back from Printer Setup without saving shows the note linking to Printer Setup, not Kiosk Setup`.
  - `PrinterTools`: `web with saved settings shows the saved printer tools`; `web without saved settings opens the printer step`; `finishing the printer step from the station returns to the station`.
  - `KioskShell`: `web kiosk shows the label takeover while a web build runs` (and not when no printer is saved).
  - Routing: `web /labels/station renders the Printing Station, not the placeholder`; `/labels/bulk is still the placeholder`.
- [ ] **Step 2: Run** `npx vitest run src/pages src/layout` — expect FAIL on the new cases.
- [ ] **Step 3: Implement.** `PrintingStation` takes its edge calls from `labelBackend()` (`getLabel`, `recordPrinted`, `recordedIds`, `getStatus`) and passes `deviceWord` to the queue; laptop header and copy stay exactly as they are; web header text: `"{ready} labels ready"` plus, when `errors > 0`, `" · {errors} couldn't be made"` with each reason from `noLabelText`. Redirect: on the web with no saved settings, navigate to `/labels/printers` with router state `{ returnTo: '/labels/station' }`; Printer Setup's finish returns there with state `{ fromPrinterSetup: true }`, which suppresses the redirect. `KioskShell` shows `<LabelRegenScreen getStatus={webLabelBackend.getStatus} />` when `!isLaptop()`, signed in, a web printer is saved and not on `/setup`.
- [ ] **Step 4: Run** `npx vitest run` (whole kiosk suite) — expect PASS.
- [ ] **Step 5: Commit** `feat(kiosk): web Printing Station prints labels by scan over USB`.

### Task 7: Merge gate

- [ ] **Step 1:** From `kiosk/`: `npx vitest run` — all pass; note the count.
- [ ] **Step 2:** `npx tsc -b` from `kiosk/` — clean.
- [ ] **Step 3:** `npm run build` from `kiosk/` — clean, and the worker chunk is emitted.
- [ ] **Step 4:** `npm run build:labelgen` then `git status --short` — the Android/iOS bundles are unchanged.
- [ ] **Step 5:** Fix anything found, commit `chore(kiosk): web label printing merge gate`.
