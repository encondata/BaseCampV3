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
export function cellText(cell: XLSX.CellObject | undefined, date1904 = false): string {
  if (!cell || cell.v === undefined || cell.v === null || cell.t === 'e') return '';
  const v = cell.v;
  if (typeof v === 'number') {
    // a value under 1 has no date part (a time-only format): keep its number
    if (v >= 1 && cell.z !== undefined && XLSX.SSF.is_date(cell.z)) {
      const d = XLSX.SSF.parse_date_code(v, { date1904 });
      return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

function sheetRows(ws: XLSX.WorkSheet | undefined, date1904 = false): string[][] {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows: string[][] = [];
  // from row/column 0 so an index + 1 is the sheet's own row number and letter
  for (let r = 0; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined, date1904));
    }
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

export function readWorkbook(data: ArrayBuffer): SheetData[] {
  // codepage 65001 reads CSV bytes as UTF-8 (xlsx/xls ignore it)
  const wb = XLSX.read(data, { type: 'array', cellNF: true, raw: true, codepage: 65001 });
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  return wb.SheetNames.map((name) => ({ name, rows: sheetRows(wb.Sheets[name], date1904) }));
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
  let width = header.length;
  for (const r of body) if (r.length > width) width = r.length;
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
