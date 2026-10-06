# Convert a customer From-To Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bulk Actions tool that reads a customer's From-To spreadsheet in the browser, maps its columns onto our From-To template (with suggestions), and downloads a converted .xlsx for the From-To import.

**Architecture:** One read-only API addition (`format=json` on the existing template endpoint) supplies the template columns and aliases. A pure TS module (`portal/src/lib/ftConvert.ts`) does reading, header detection, suggestions and conversion with SheetJS. A page on the shared `BulkToolPage` shell renders upload → match → preview/download, reusing the From-To import's drop zone (extracted to `FileDropzone`).

**Tech Stack:** FastAPI (api/), React + TypeScript + SheetJS `xlsx` + vitest/testing-library (portal/).

Spec: `docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md` — read it; its rules (cell text, header detection, suggestion table, copy) are binding.

## Global Constraints

- Card: title `Convert a customer From-To`; description `Upload a customer's From-To, match its columns to ours, and download a sheet ready for the From-To import.`; button `Open`; `resource: 'initiatives', action: 'change'`; route `/bulk/from-to-convert` wrapped in `<ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}>`.
- The customer file is never uploaded or stored; it is read in the browser with the existing `xlsx` package (`import * as XLSX from 'xlsx'`).
- Target columns come only from `GET /initiatives/assets/import-template?format=json` (permission `initiatives:change` + global scope, same as the existing template download). Response: `{"columns": [{"header", "field", "aliases", "required", "accepts", "example"}]}` in template order.
- Read options: `XLSX.read(data, { type: 'array', cellNF: true, raw: true })`.
- Output: `<base name>-converted.xlsx`, one sheet `Move Assets`, row 1 = every template header in template order, unmatched columns blank.
- No file splitting. No DB writes. No apply summary.
- Page copy is verbatim from the spec's "Page layout" section.
- Reuse portal idioms: `BulkToolPage`, `DataTable`, `ComboBox` (with `portal` inside tables), `mini-btn` / `btn-solid`, `chip`, `pf-error`, `set-note`. No native `<select>` for data lists.
- American English in all copy, comments and docs.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Never commit `api/src/serversherpa/_dev_reload.py`.
- API tests: from `api/`, `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_ft_convert .venv/bin/pytest -q <files>` (foreground). Portal: from `portal/`, `npx vitest run <files>` and `npx tsc -b`.

---

### Task 1: API — template columns as JSON

**Files:**
- Modify: `api/src/serversherpa/imports/parsing.py` (add `TEMPLATE_GUIDE` and `template_columns()` after `SAMPLE_ROWS`)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`move_asset_import_template`, ~line 1314; import `template_columns`)
- Test: `api/tests/test_move_asset_import_api.py`

**Interfaces:**
- Produces: `GET /initiatives/assets/import-template?format=json` → `{"columns": [{"header": str, "field": str, "aliases": list[str], "required": bool, "accepts": str, "example": str}, ...]}` (25 entries, `TEMPLATE_HEADERS` order).

- [ ] **Step 1: Failing tests.** In `test_move_asset_import_api.py` add (import `TEMPLATE_GUIDE, TEMPLATE_HEADERS` from `serversherpa.imports.parsing`):

```python
async def test_template_columns_json(client, seeded_user):
    headers = await login(client)
    resp = await client.get(
        "/initiatives/assets/import-template?format=json", headers=headers)
    assert resp.status_code == 200
    cols = resp.json()["columns"]
    assert [c["header"] for c in cols] == TEMPLATE_HEADERS
    assert cols[0] == {
        "header": "Serial Number", "field": "serial_number",
        "aliases": ["serial number"], "required": True,
        "accepts": TEMPLATE_GUIDE["Serial Number"], "example": "SN-0001",
    }
    pod = next(c for c in cols if c["field"] == "source_pod")
    assert {"pod", "pod #", "source pod"} <= set(pod["aliases"])
    vendor = next(c for c in cols if c["field"] == "vendor_involvement")
    assert "vendor involvment" in vendor["aliases"]
    assert all(c["accepts"] for c in cols)
    assert sum(c["required"] for c in cols) == 1
```

and in the existing view-only test (the one asserting a 403 on `/initiatives/assets/import-template`) add:

```python
    resp = await client.get("/initiatives/assets/import-template?format=json",
                            headers=viewer)
    assert resp.status_code == 403
```

- [ ] **Step 2: Run** `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_ft_convert .venv/bin/pytest -q tests/test_move_asset_import_api.py` — the new test fails (422 / import error).
- [ ] **Step 3: Implement.** In `parsing.py` after `SAMPLE_ROWS`:

```python
# One line per template column for the Bulk Actions "Convert a customer
# From-To" column guide (served by import-template?format=json).
TEMPLATE_GUIDE: dict[str, str] = {
    "Serial Number": "The asset's serial number. Required unless Generate serials is on when you import.",
    "Asset Name": "Hostname or label, free text.",
    "Asset Make": "Manufacturer, matched against the make and model catalog.",
    "Asset Model": "Model, matched against the make and model catalog.",
    "RFID Tag": "The RFID tag (EPC) on the asset, if it has one.",
    "Priority": "Move wave or priority, free text.",
    "Disposition": "What happens to the asset (for example Relocate), free text.",
    "Owner": "The team or customer that owns the asset, free text.",
    "Source Pod": "Pod number where the asset is today.",
    "Source Rack": "Rack the asset sits in today.",
    "Source RU": "Rack unit today; halves like 3.5 are allowed.",
    "Source Position": "Front or Rear today.",
    "Destination Pod": "Pod number the asset moves to.",
    "Destination Rack": "Rack the asset moves to.",
    "Destination RU": "Rack unit it moves to; halves like 3.5 are allowed.",
    "Destination Position": "Front or Rear after the move.",
    "Data 1": "Data cable connection (for example a switch port), free text.",
    "Data 2": "Data cable connection, free text.",
    "Data 3": "Data cable connection, free text.",
    "Data 4": "Data cable connection, free text.",
    "Data 5": "Data cable connection, free text.",
    "Data 6": "Data cable connection, free text.",
    "Mgmt 1": "Management cable connection, free text.",
    "Mgmt 2": "Management cable connection, free text.",
    "Vendor Involvement": "yes or no: whether a vendor is involved with this asset.",
}


def template_columns() -> list[dict]:
    """The From-To template's columns in order, with the header aliases the
    import accepts for each, for tools that map other spreadsheets onto it."""
    out: list[dict] = []
    for header, field in zip(TEMPLATE_HEADERS, CANONICAL, strict=True):
        out.append({
            "header": header,
            "field": field,
            "aliases": sorted(k for k, v in HEADER_MAP.items() if v == field),
            "required": field == "serial_number",
            "accepts": TEMPLATE_GUIDE[header],
            "example": SAMPLE_ROWS[0][header],
        })
    return out
```

In the route, add `template_columns` to the `serversherpa.imports.parsing` import and, before the `raise _err(422, "unknown_format")`:

```python
    if format == "json":
        return {"columns": template_columns()}
```

(The existing `_require_global(actor)` and `require_permission("initiatives", "change")` already guard it.)

- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat(api): From-To template columns as JSON (import-template?format=json)`.

---

### Task 2: Portal — `ftConvert` library + API client

**Files:**
- Modify: `portal/src/lib/api.ts` (next to `downloadMoveAssetTemplate`, ~line 3326)
- Create: `portal/src/lib/ftConvert.ts`
- Create: `portal/src/lib/ftConvert.test.ts`

**Interfaces:**
- Consumes: Task 1's JSON shape.
- Produces (exact names):
  - `api.ts`: `export interface MoveAssetTemplateColumn { header: string; field: string; aliases: string[]; required: boolean; accepts: string; example: string }` and `export async function getMoveAssetTemplateColumns(): Promise<MoveAssetTemplateColumn[]>`.
  - `ftConvert.ts`: `SheetData { name: string; rows: string[][] }`, `SourceColumn { index: number; header: string; samples: string[] }`, `type ColumnMapping = Record<number, string>`, `Conversion { header: string[]; rows: string[][]; blankRows: number; ignoredColumns: number }`, functions `cellText`, `readWorkbook(data: ArrayBuffer): SheetData[]`, `sheetHasData(s: SheetData): boolean`, `detectHeaderRow(rows: string[][]): number` (0-based), `sourceColumns(rows, headerIndex): SourceColumn[]`, `normalize(s): string`, `keywordField(header): string | null`, `suggestMapping(columns, template): ColumnMapping`, `convertRows(rows, headerIndex, columns, mapping, template): Conversion`, `convertedWorkbook(conv): XLSX.WorkBook`, `convertedFilename(source: string): string`, const `CONVERTED_SHEET = 'Move Assets'`.

- [ ] **Step 1: Failing tests** in `ftConvert.test.ts` (node env is fine; build inputs with SheetJS):

```ts
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import type { MoveAssetTemplateColumn } from './api';
import {
  CONVERTED_SHEET, convertRows, convertedFilename, convertedWorkbook, detectHeaderRow,
  keywordField, normalize, readWorkbook, sheetHasData, sourceColumns, suggestMapping,
} from './ftConvert';

const HEADERS = ['Serial Number', 'Asset Name', 'Asset Make', 'Asset Model', 'RFID Tag',
  'Priority', 'Disposition', 'Owner', 'Source Pod', 'Source Rack', 'Source RU',
  'Source Position', 'Destination Pod', 'Destination Rack', 'Destination RU',
  'Destination Position', 'Data 1', 'Data 2', 'Data 3', 'Data 4', 'Data 5', 'Data 6',
  'Mgmt 1', 'Mgmt 2', 'Vendor Involvement'];
const FIELDS = HEADERS.map((h) => h.toLowerCase().replace(/ /g, '_')
  .replace('vendor_involvement', 'vendor_involvement'));
const TEMPLATE: MoveAssetTemplateColumn[] = HEADERS.map((header, i) => ({
  header, field: FIELDS[i], aliases: [header.toLowerCase()],
  required: i === 0, accepts: 'x', example: '',
}));
TEMPLATE[8].aliases.push('pod', 'pod #');           // the import's lone-pod aliases

function xlsxBuffer(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
```

Cases to write (one `it` each, assert exact values):
1. `readWorkbook` keeps sheet order and names; trailing blank rows trimmed; `sheetHasData` false for an empty sheet.
2. Cell text: number `123456789012` → `'123456789012'`; `12.5` → `'12.5'`; boolean → `'TRUE'`; string `'  web-01 '` → `'web-01'`; a date-formatted number (build the sheet, then set `ws['A2'] = { t: 'n', v: 45658, z: 'yyyy-mm-dd' }` before writing) → `'2025-01-01'`.
3. CSV keeps text: `readWorkbook(new TextEncoder().encode('Serial,Name\n00123,web-01\n').buffer)` → rows `[['Serial','Name'],['00123','web-01']]`.
4. `detectHeaderRow`: `[['Acme Corp move list'], [], ['Hostname','Serial'], ['a','b']]` → `2`; a sheet with only one-cell rows → `0`.
5. `sourceColumns` (header index 0): blank header with data below → `Column C`; blank header with no data dropped; `Serial` twice → `Serial`, `Serial (2)` (and `serial` lowercase also counts as a duplicate); samples are up to three distinct non-blank values in order.
6. `normalize('S/N #')` → `'s n'`.
7. `keywordField` table: `Hostname`→`asset_name`, `S/N`→`serial_number`, `Service Tag`→`serial_number`, `EPC`→`rfid_tag`, `Manufacturer`→`asset_make`, `Vendor`→`asset_make`, `Vendor Involved`→`vendor_involvement`, `Model Name`→`asset_model`, `Rack Name`→`source_rack`, `From Cabinet`→`source_rack`, `To Rack`→`destination_rack`, `New U`→`destination_ru`, `Rack Position`→`source_ru`, `Dest Side`→`destination_position`, `Pod`→`source_pod`, `Data 3`→`data_3`, `Management 2`→`mgmt_2`, `Wave`→`priority`, `Notes`→`null`.
8. `suggestMapping`: exact beats keyword (columns `Hostname` (0) and `Asset Name` (1) → `{1: 'Asset Name'}` and Hostname unmapped); one target per column (two `Serial` columns → only the first mapped); `Pod #` → `Source Pod` via alias.
9. `convertRows` + `convertedWorkbook`: header row is all 25 headers; matched values land in the right template position; a row blank in every customer column is dropped and counted; `ignoredColumns` counts unmatched customer columns; the workbook's only sheet is `CONVERTED_SHEET`, and `XLSX.utils.sheet_to_json(ws, { header: 1 })[0]` equals `HEADERS`.
10. `convertedFilename('Acme FT v3.xlsx')` → `'Acme FT v3-converted.xlsx'`; `'list.csv'` → `'list-converted.xlsx'`; `'noext'` → `'noext-converted.xlsx'`.

- [ ] **Step 2: Run** `npx vitest run src/lib/ftConvert.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement.**

`api.ts`:

```ts
/** One From-To template column, as GET /initiatives/assets/import-template?format=json serves it. */
export interface MoveAssetTemplateColumn {
  header: string;
  field: string;
  aliases: string[];
  required: boolean;
  accepts: string;
  example: string;
}

export async function getMoveAssetTemplateColumns(): Promise<MoveAssetTemplateColumn[]> {
  const resp = await apiFetch('/initiatives/assets/import-template?format=json');
  if (!resp.ok) throw await errorFrom(resp);
  return (await resp.json() as { columns: MoveAssetTemplateColumn[] }).columns;
}
```

`ftConvert.ts`:

```ts
/**
 * ftConvert — the pure half of Bulk Actions › Convert a customer From-To
 * (/bulk/from-to-convert): read a customer's workbook into text rows, find
 * the header row, list their columns, suggest which of our From-To template
 * columns each one is, and build the converted workbook. No React, no
 * network: the file never leaves the browser.
 * Spec: docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md
 */
import * as XLSX from 'xlsx';

import type { MoveAssetTemplateColumn } from './api';

export interface SheetData { name: string; rows: string[][] }
export interface SourceColumn { index: number; header: string; samples: string[] }
/** Customer column index → template header; a missing or '' entry means Skip. */
export type ColumnMapping = Record<number, string>;
export interface Conversion { header: string[]; rows: string[][]; blankRows: number; ignoredColumns: number }

export const CONVERTED_SHEET = 'Move Assets';

const pad = (n: number) => String(n).padStart(2, '0');

/** One cell as the text the From-To import would read. Numbers use the raw
 *  value (formatted text turns long serials into 1.2E+11); date-formatted
 *  numbers become YYYY-MM-DD straight from the serial, no time zone. */
export function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null || cell.t === 'e') return '';
  const v = cell.v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (cell.z !== undefined && XLSX.SSF.is_date(cell.z)) {
      const d = XLSX.SSF.parse_date_code(v);
      return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

function sheetRows(ws: XLSX.WorkSheet | undefined): string[][] {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows: string[][] = [];
  // from row/column 0 so an index + 1 is the sheet's own row number and letter
  for (let r = 0; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined));
    }
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

export function readWorkbook(data: ArrayBuffer): SheetData[] {
  const wb = XLSX.read(data, { type: 'array', cellNF: true, raw: true });
  return wb.SheetNames.map((name) => ({ name, rows: sheetRows(wb.Sheets[name]) }));
}

export function sheetHasData(s: SheetData): boolean {
  return s.rows.some((r) => r.some((v) => v !== ''));
}

/** The first row (within the first 20) with at least two filled cells; else row 1. */
export function detectHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (rows[i].filter((v) => v !== '').length >= 2) return i;
  }
  return 0;
}

export function sourceColumns(rows: string[][], headerIndex: number): SourceColumn[] {
  const header = rows[headerIndex] ?? [];
  const body = rows.slice(headerIndex + 1);
  const width = Math.max(header.length, 0, ...body.map((r) => r.length));
  const seen = new Map<string, number>();
  const out: SourceColumn[] = [];
  for (let c = 0; c < width; c++) {
    const values = body.map((r) => r[c] ?? '').filter((v) => v !== '');
    let name = header[c] ?? '';
    if (!name) {
      if (!values.length) continue;
      name = `Column ${XLSX.utils.encode_col(c)}`;
    }
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) name = `${name} (${n})`;
    out.push({ index: c, header: name, samples: [...new Set(values)].slice(0, 3) });
  }
  return out;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const DEST_WORDS = ['to', 'dest', 'destination', 'dst', 'new', 'target'];

/** The keyword-rule table from the spec, first match wins. */
export function keywordField(header: string): string | null {
  const t = normalize(header).split(' ').filter(Boolean);
  const has = (w: string) => t.includes(w);
  const any = (ws: string[]) => ws.some(has);
  const side = any(DEST_WORDS) ? 'destination' : 'source';
  const digit = (allowed: string[]) => t.find((w) => allowed.includes(w));
  const sn = t.some((w, i) => w === 's' && t[i + 1] === 'n');

  if (has('vendor') && any(['involvement', 'involved'])) return 'vendor_involvement';
  if (has('serial') || has('sn') || sn || (has('service') && has('tag'))) return 'serial_number';
  if (any(['rfid', 'epc'])) return 'rfid_tag';
  if (has('model')) return 'asset_model';
  if (any(['make', 'manufacturer', 'mfr', 'mfg', 'brand', 'vendor'])) return 'asset_make';
  if (has('data')) { const d = digit(['1', '2', '3', '4', '5', '6']); if (d) return `data_${d}`; }
  if (any(['mgmt', 'management'])) { const d = digit(['1', '2']); if (d) return `mgmt_${d}`; }
  if (any(['ru', 'u', 'elevation']) || (has('rack') && has('position'))) return `${side}_ru`;
  if (any(['position', 'orientation', 'face', 'side'])) return `${side}_position`;
  if (any(['rack', 'cabinet', 'cab'])) return `${side}_rack`;
  if (has('pod')) return `${side}_pod`;
  if (any(['hostname', 'host', 'name'])) return 'asset_name';
  if (any(['priority', 'wave'])) return 'priority';
  if (has('disposition')) return 'disposition';
  if (has('owner')) return 'owner';
  return null;
}

export function suggestMapping(columns: SourceColumn[], template: MoveAssetTemplateColumn[]): ColumnMapping {
  const byName = new Map<string, string>();
  for (const t of template) {
    for (const a of [t.header, ...t.aliases]) {
      const k = normalize(a);
      if (!byName.has(k)) byName.set(k, t.header);
    }
  }
  const byField = new Map(template.map((t) => [t.field, t.header]));
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  const assign = (col: SourceColumn, header: string | undefined) => {
    if (!header || taken.has(header) || mapping[col.index]) return;
    mapping[col.index] = header;
    taken.add(header);
  };
  for (const c of columns) assign(c, byName.get(normalize(c.header)));
  for (const c of columns) {
    const f = keywordField(c.header);
    assign(c, f ? byField.get(f) : undefined);
  }
  return mapping;
}

export function convertRows(
  rows: string[][], headerIndex: number, columns: SourceColumn[],
  mapping: ColumnMapping, template: MoveAssetTemplateColumn[],
): Conversion {
  const header = template.map((t) => t.header);
  const position = new Map(header.map((h, i) => [h, i]));
  const active: [number, number][] = [];
  for (const c of columns) {
    const target = mapping[c.index];
    const at = target ? position.get(target) : undefined;
    if (at !== undefined) active.push([c.index, at]);
  }
  const out: string[][] = [];
  let blankRows = 0;
  for (const r of rows.slice(headerIndex + 1)) {
    if (columns.every((c) => (r[c.index] ?? '') === '')) { blankRows++; continue; }
    const line = header.map(() => '');
    for (const [src, dst] of active) line[dst] = r[src] ?? '';
    out.push(line);
  }
  return { header, rows: out, blankRows, ignoredColumns: columns.length - active.length };
}

export function convertedWorkbook(conv: Conversion): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([conv.header, ...conv.rows]), CONVERTED_SHEET);
  return wb;
}

export function convertedFilename(source: string): string {
  const base = source.replace(/\.[^./\\]+$/, '') || 'from-to';
  return `${base}-converted.xlsx`;
}
```

If `XLSX.SSF.is_date` / `parse_date_code` typings differ in the installed version, adapt the call (check `node_modules/xlsx/types/index.d.ts`) but keep the behavior.

- [ ] **Step 4: Run** `npx vitest run src/lib/ftConvert.test.ts` and `npx tsc -b` — pass.
- [ ] **Step 5: Commit** `feat(portal): ftConvert library for Convert a customer From-To`.

---

### Task 3: Portal — the page, the shared drop zone, the card and the route

**Files:**
- Create: `portal/src/components/FileDropzone.tsx` (extracted from `portal/src/components/imports/ImportUploadFields.tsx`)
- Modify: `portal/src/components/imports/ImportUploadFields.tsx` (use `FileDropzone`; behavior and markup unchanged)
- Create: `portal/src/components/bulk/FromToConvert.tsx` (the Upload pane)
- Create: `portal/src/pages/BulkFromToConvert.tsx`
- Modify: `portal/src/pages/BulkActions.tsx` (`BULK_TOOLS` entry, after `new-move`)
- Modify: `portal/src/App.tsx` (route, beside `/bulk/new-move`)
- Modify: `portal/src/styles/bulk.css` (only what the new pane needs)
- Test: `portal/src/components/bulk/FromToConvert.test.tsx`, `portal/src/pages/BulkActions.test.tsx`, existing `ImportUploadFields`/`ImportMoveAssets` tests must still pass

**Interfaces:**
- Consumes: Task 2's `getMoveAssetTemplateColumns`, `MoveAssetTemplateColumn`, and every `ftConvert` export.
- Produces: `FileDropzone({ file, onFile, busy, inputRef, accept, hint })` — `accept` default `'.csv,.xlsx,.xls'`, `hint` default `'CSV or Excel spreadsheet — .csv, .xlsx, or .xls'`; same classes (`imp-dropzone`, …) and same drag/drop/remove behavior as today.

- [ ] **Step 1: Failing tests.**

`FromToConvert.test.tsx` (jsdom). Mock `../../lib/api`'s `getMoveAssetTemplateColumns` only through the page-level prop: the pane takes `columns: MoveAssetTemplateColumn[]` as a prop (the page fetches), so tests render `<FromToConvert columns={TEMPLATE} />` with the same `TEMPLATE` fixture shape as Task 2's test. Spy `XLSX.writeFile` with `vi.spyOn(XLSX, 'writeFile').mockImplementation(() => undefined)` — if the ESM namespace is not spy-able, `vi.mock('xlsx', async (orig) => ({ ...(await orig()), writeFile: vi.fn() }))`. Upload a real workbook: build an `.xlsx` with SheetJS, wrap it in `new File([buf], 'Acme FT.xlsx')`, fire `change` on the drop zone's file input (`fireEvent.change(input, { target: { files: [file] } })`). Cases:
1. After upload the match table lists each customer column with its samples, and suggestions are pre-filled with a `Suggested` chip (headers `Hostname`, `S/N`, `To Rack`, `Notes` → Asset Name, Serial Number, Destination Rack, Skip).
2. A target picked in one row is not offered in another row's ComboBox; choosing Skip frees it again (open the other row's ComboBox and check the options).
3. Changing a suggested row removes its `Suggested` chip.
4. With no Serial Number matched the note `Serial Number isn't matched. Turn on Generate serials when you import, or the rows will be rejected.` shows; with it matched it doesn't.
5. The counts line reads `{rows} rows converted · {blank} blank rows dropped · {ignored} of their columns ignored` for a fixture with one blank row and one unmatched column.
6. `Download converted file` calls `XLSX.writeFile` with a workbook whose only sheet is `Move Assets` and filename `Acme FT-converted.xlsx`; the first data row has the expected values in template positions. The button is disabled after `Clear all`.
7. A workbook with two data sheets shows the Sheet ComboBox; picking the second sheet re-reads columns. A one-sheet workbook shows no Sheet control.
8. A title row above the headers is skipped by default (Header row shows `2`); changing Header row to `1` re-reads columns.

`BulkActions.test.tsx`: the `Convert a customer From-To` card shows with `initiatives:change` and links to `/bulk/from-to-convert`; hidden without it (follow the file's existing per-card pattern).

- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement.**
  - **FileDropzone:** move the `<label className="imp-dropzone…">…</label>` block (with its `dragOver` state and `remove`) out of `ImportUploadFields` into `components/FileDropzone.tsx` unchanged except `accept`/`hint` props; `ImportUploadFields` renders `<FileDropzone file={file} onFile={onFile} busy={busy} inputRef={inputRef} />`. Keep `formatBytes` where it's used (move it with the dropzone if only the dropzone uses it).
  - **Page** `pages/BulkFromToConvert.tsx`: fetch `getMoveAssetTemplateColumns()` once on mount; render `BulkToolPage` with the spec's title, hint and limit note; `guide = columns.map((c) => ({ key: c.header, required: c.required, accepts: c.accepts, example: c.example }))`; downloads `Template (.xlsx)` / `Template (.csv)` running `downloadMoveAssetTemplate('xlsx' | 'csv')`; children: while loading `<p className="page-hint">Loading our template columns…</p>`, on error `<p className="pf-error">Couldn't load our template columns. Reload the page to try again.</p>`, else `<FromToConvert columns={columns} />`. Header comment in the house style naming the spec.
  - **Pane** `components/bulk/FromToConvert.tsx` (`<div className="bulk-import">`), state: `file`, `sheets: SheetData[]`, `sheetName`, `headerRow` (1-based number shown), `mapping`, `suggested: ColumnMapping` (the suggestions as made, for the chip), `error`.
    - On file: `readWorkbook(await file.arrayBuffer())`; pick the first sheet with data (none → error `That file has no data.`; unreadable → `That file could not be read.`); `headerRow = detectHeaderRow(rows) + 1`; columns via `sourceColumns`; `mapping = suggested = suggestMapping(columns, template)`. Re-run the last three when the sheet or header row changes.
    - Sheet control: only when 2+ sheets have data; `ComboBox` labeled `Sheet` with those sheet names. Header row: `<label>Header row</label><input type="number" min={1} max={rows.length}>` inside the house `pf-form` idiom used by other bulk tools (match neighbors' markup; clamp to 1..rows.length).
    - Match table: `<p className="eyebrow-sm">` is NOT added (the Upload section heading already exists); use a small bold label line `Match columns` styled like other in-pane sub-labels (reuse `imp-options-sublabel` if it fits). Counts line `{n} of {m} columns matched` + mini buttons `Clear all` (mapping = {}) and `Use suggestions` (mapping = suggested). `DataTable ariaLabel="Column matches"` columns `Their column` / `Sample values` / `Our column`; the third cell is `<ComboBox portal ariaLabel={`Our column for ${col.header}`} options={[{ value: '', label: 'Skip' }, ...free targets]} value={mapping[col.index] ?? ''} onChange={…} />` followed by `<span className="chip c-blue">Suggested</span>` when `mapping[i]` is non-empty and equals `suggested[i]`. Free targets = template headers not used by any OTHER row.
    - Serial note (`set-note`) per the spec, when no row maps to the template column whose `field === 'serial_number'`.
    - Preview: `DataTable ariaLabel="Converted preview"` with only matched template columns (template order) and the first 10 converted rows; under it the counts line; then `<button className="btn-solid" disabled={matchedCount === 0}>Download converted file</button>` calling `XLSX.writeFile(convertedWorkbook(conv), convertedFilename(file.name))`.
    - Sample values cell: `col.samples.join(' · ') || '—'`.
  - **Card** in `BULK_TOOLS` (after `new-move`): `{ key: 'from-to-convert', title: 'Convert a customer From-To', description: "Upload a customer's From-To, match its columns to ours, and download a sheet ready for the From-To import.", resource: 'initiatives', action: 'change', to: '/bulk/from-to-convert', button: 'Open' }`.
  - **Route** in `App.tsx` beside `/bulk/new-move`: `<Route path="/bulk/from-to-convert" element={<ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}><BulkFromToConvert /></ProtectedRoute>} />`.
  - CSS: only additions the pane needs, in `styles/bulk.css`, using existing tokens; no `*-head` selectors (list typography guardrail).
- [ ] **Step 4: Run** `npx vitest run src/components/bulk src/pages/BulkActions.test.tsx src/components/imports src/pages/ImportMoveAssets.test.tsx src/lib/ftConvert.test.ts` (skip files that don't exist), then the full `npx vitest run` and `npx tsc -b` — pass (the list-typography and other guardrail tests run in the full suite).
- [ ] **Step 5: Commit** `feat(portal): Convert a customer From-To bulk tool (/bulk/from-to-convert)`.
