import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImportJobOut, ImportRowDetail } from './api';
import {
  buildImportReport, downloadImportReport, localDateTime, localDay, moveSlug, workbookBytes,
} from './importReport';

// Local-time constructor: 25 Sep 2026, 14:05 wherever the suite runs.
const NOW = new Date(2026, 8, 25, 14, 5);

const DETAILS: ImportRowDetail[] = [
  { row: 5, serial_number: 'SN4', status: 'error', message: 'Serial Number is required' },
  {
    row: 2, serial_number: 'SN1', status: 'created', message: 'Asset added to move',
    make_model_final: 'Dell PowerEdge R740', match_method: 'alias',
    asset_created: true, serial_generated: false,
  },
  {
    row: 3, serial_number: 'SN2', status: 'updated', message: 'Asset updated',
    make_model_final: 'Cisco C9300', match_method: 'exact',
    asset_created: false, serial_generated: true,
  },
  { row: 4, serial_number: 'SN3', status: 'review', message: "Make/Model 'Foo Bar' not found" },
];

function job(over: Partial<ImportJobOut> = {}): ImportJobOut {
  return {
    id: 'job-1', initiative_id: 'i1', kind: 'move_assets', filename: 'nap11-from-to.xlsx',
    options: {}, phase: 'validate', status: 'completed',
    total_rows: 4, processed_rows: 4, created_count: 0, updated_count: 0, error_count: 0,
    results: { summary: { created: 1, updated: 1, review: 1, errors: 1 }, details: DETAILS },
    error: null, created_at: '2026-09-25T00:00:00Z', started_at: null, finished_at: null,
    ...over,
  };
}

const build = (over: Partial<ImportJobOut> = {}, moveName = 'NAP11 Hall Migration') =>
  buildImportReport({ job: job(over), moveName, generatedBy: 'Jimmy Henderson', now: NOW });

const rowsOf = (wb: XLSX.WorkBook) =>
  XLSX.utils.sheet_to_json<Array<string | number>>(wb.Sheets.Rows, { header: 1, defval: '' });

const summaryOf = (wb: XLSX.WorkBook) =>
  XLSX.utils.sheet_to_json<[string, string | number]>(wb.Sheets.Summary, { header: 1 });

const xmlOf = (bytes: Uint8Array, path: string): string => {
  const cfb = XLSX.CFB as {
    read(d: Uint8Array, o: { type: 'array' }): object;
    find(z: object, p: string): { content: Uint8Array } | null;
  };
  const entry = cfb.find(cfb.read(bytes, { type: 'array' }), path);
  return new TextDecoder().decode(entry!.content);
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Rows sheet', () => {
  it('has the Rows and Summary sheets and the eight headers', () => {
    const { workbook } = build();
    expect(workbook.SheetNames).toEqual(['Rows', 'Summary']);
    expect(rowsOf(workbook)[0]).toEqual([
      'Row', 'Serial', 'Result', 'Message', 'Make / model', 'Matched by',
      'New asset', 'Serial generated',
    ]);
  });

  it('writes one line per detail, sorted by row, with labels and Yes/No values', () => {
    const rows = rowsOf(build().workbook);
    expect(rows.slice(1)).toEqual([
      [2, 'SN1', 'Created', 'Asset added to move', 'Dell PowerEdge R740', 'alias', 'Yes', 'No'],
      [3, 'SN2', 'Updated', 'Asset updated', 'Cisco C9300', 'exact', 'No', 'Yes'],
      [4, 'SN3', 'Needs review', "Make/Model 'Foo Bar' not found", '', '', '', ''],
      [5, 'SN4', 'Error', 'Serial Number is required', '', '', '', ''],
    ]);
  });

  it('writes truly empty cells for absent optional values, not blank strings', () => {
    const details: ImportRowDetail[] = [
      { row: 2, serial_number: 'SN9', status: 'review', message: "Make/Model 'Foo' not found" },
    ];
    const { workbook } = build({ results: { summary: {}, details } });
    const ws = workbook.Sheets.Rows;
    // Absent, not a blank-string cell: Excel's ISBLANK() reads true.
    expect(ws.E2).toBeUndefined();
    expect(ws.F2).toBeUndefined();
    expect(ws.G2).toBeUndefined();
    expect(ws.H2).toBeUndefined();
  });

  it('includes every detail row, not only the 500 shown on screen', () => {
    const details: ImportRowDetail[] = Array.from({ length: 1200 }, (_, i) => ({
      row: 1200 - i, serial_number: `SN-${1200 - i}`, status: 'created' as const,
      message: 'Asset added to move',
    }));
    const rows = rowsOf(build({ results: { summary: {}, details } }).workbook);
    expect(rows).toHaveLength(1201);
    expect(rows[1][0]).toBe(1);
    expect(rows[1200][0]).toBe(1200);
    expect(rows[1200][1]).toBe('SN-1200');
  });

  it('fits column widths to the content, capped at 60 characters', () => {
    const long = { row: 6, serial_number: 'SN5', status: 'error' as const, message: 'x'.repeat(200) };
    const { workbook } = build({
      results: { summary: {}, details: [...DETAILS, long] },
    });
    const cols = workbook.Sheets.Rows['!cols']!;
    expect(cols).toHaveLength(8);
    expect(cols[0]).toEqual({ wch: 3 });    // "Row"
    expect(cols[2]).toEqual({ wch: 12 });   // "Needs review"
    expect(cols[3]).toEqual({ wch: 60 });   // 200-character message, capped
    expect(cols[7]).toEqual({ wch: 16 });   // "Serial generated"
  });

  it('writes a bold, frozen header row on the Rows sheet only', () => {
    const bytes = workbookBytes(build().workbook);

    const sheet = xmlOf(bytes, '/xl/worksheets/sheet1.xml');
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    const style = /<c r="A1" s="(\d+)"/.exec(sheet)?.[1];
    expect(style).toBeDefined();
    for (const col of 'ABCDEFGH') expect(sheet).toContain(`<c r="${col}1" s="${style}"`);
    expect(sheet).not.toContain('<c r="A2" s=');

    // The header's cell format points at a bold font; the default one is not bold.
    const styles = xmlOf(bytes, '/xl/styles.xml');
    const cellXfs = styles.slice(styles.indexOf('<cellXfs'));
    const headerXf = [...cellXfs.matchAll(/<xf [^>]*\/>/g)][Number(style)][0];
    const fontId = Number(/fontId="(\d+)"/.exec(headerXf)![1]);
    const fonts = [...styles.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1]);
    expect(fonts[fontId]).toContain('<b/>');
    expect(fonts[0]).not.toContain('<b/>');

    expect(xmlOf(bytes, '/xl/worksheets/sheet2.xml')).not.toContain('<pane');

    // Still a readable workbook with the same rows.
    const back = XLSX.read(bytes, { type: 'array' });
    expect(back.SheetNames).toEqual(['Rows', 'Summary']);
    expect(rowsOf(back)).toEqual(rowsOf(build().workbook));
  });

  it('falls back to a plain, unstyled workbook when the styles.xml patch cannot be applied', () => {
    const cfb = XLSX.CFB as unknown as { find: (zip: object, path: string) => unknown };
    const originalFind = cfb.find;
    const spy = vi.spyOn(cfb, 'find').mockImplementation((zip: object, path: string) => (
      path === '/xl/styles.xml' ? null : originalFind(zip, path)
    ));

    const bytes = workbookBytes(build().workbook);
    spy.mockRestore();

    // Still opens, with the same rows, but with no frozen pane or bold style.
    const back = XLSX.read(bytes, { type: 'array' });
    expect(back.SheetNames).toEqual(['Rows', 'Summary']);
    expect(rowsOf(back)).toEqual(rowsOf(build().workbook));
    expect(xmlOf(bytes, '/xl/worksheets/sheet1.xml')).not.toContain('<pane');
  });

  it('falls back to a plain, unstyled workbook when styles.xml patches fine '
    + 'but sheet1.xml does not match', () => {
    const cfb = XLSX.CFB as unknown as {
      find: (zip: object, path: string) => { content: Uint8Array; size: number } | null;
    };
    const originalFind = cfb.find;
    const spy = vi.spyOn(cfb, 'find').mockImplementation((zip: object, path: string) => {
      const entry = originalFind(zip, path);
      if (path !== '/xl/worksheets/sheet1.xml' || !entry) return entry;
      // styles.xml patches fine; only sheet1.xml is reshaped so neither the
      // <sheetView> nor the header <row> regex matches — the shape a future
      // SheetJS version (or an unanticipated workbook) might produce.
      const xml = new TextDecoder().decode(entry.content)
        .replace('<sheetView workbookViewId="0"/>', '<sheetView workbookViewId="0" x="1"/>');
      const content = new TextEncoder().encode(xml);
      return { ...entry, content, size: content.length };
    });

    const bytes = workbookBytes(build().workbook);
    spy.mockRestore();

    // The whole patch is one unit: a styles.xml change with no matching
    // sheet1.xml change must not ship as a half-patched file. The result is
    // the fully unpatched, valid workbook — same as the styles.xml failure.
    const back = XLSX.read(bytes, { type: 'array' });
    expect(back.SheetNames).toEqual(['Rows', 'Summary']);
    expect(rowsOf(back)).toEqual(rowsOf(build().workbook));
    expect(xmlOf(bytes, '/xl/worksheets/sheet1.xml')).not.toContain('<pane');

    const rawBytes = new Uint8Array(
      XLSX.write(build().workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
    const originalFontsCount = /<fonts count="(\d+)">/.exec(xmlOf(rawBytes, '/xl/styles.xml'))?.[1];
    expect(originalFontsCount).toBeDefined();
    const patchedFontsCount = /<fonts count="(\d+)">/.exec(xmlOf(bytes, '/xl/styles.xml'))?.[1];
    expect(patchedFontsCount).toBe(originalFontsCount);
  });
});

describe('Summary sheet', () => {
  it('describes a check', () => {
    const summary = summaryOf(build({
      results: {
        summary: { created: 1, updated: 1, review: 1, errors: 1, collisions_flagged: 3 },
        details: DETAILS,
      },
    }).workbook);
    expect(summary).toEqual([
      ['Move', 'NAP11 Hall Migration'],
      ['File', 'nap11-from-to.xlsx'],
      ['Report', 'Check (nothing imported yet)'],
      ['Generated', '2026-09-25 14:05'],
      ['Generated by', 'Jimmy Henderson'],
      ['Created', 1],
      ['Updated', 1],
      ['Needs review', 1],
      ['Errors', 1],
    ]);
  });

  it('describes an import, with collisions and orphan nodes when present', () => {
    const summary = summaryOf(build({
      phase: 'commit',
      results: {
        summary: {
          created: 7, updated: 2, review: 1, errors: 0,
          collisions_flagged: 3, orphans_flagged: 0,
        },
        details: DETAILS,
      },
    }).workbook);
    expect(summary).toEqual([
      ['Move', 'NAP11 Hall Migration'],
      ['File', 'nap11-from-to.xlsx'],
      ['Report', 'Import'],
      ['Generated', '2026-09-25 14:05'],
      ['Generated by', 'Jimmy Henderson'],
      ['Created', 7],
      ['Updated', 2],
      ['Needs review', 1],
      ['Errors', 0],
      ['Collisions flagged', 3],
      ['Orphan nodes flagged', 0],
    ]);
  });

  it('leaves out collisions and orphan nodes an import summary does not carry', () => {
    const labels = summaryOf(build({ phase: 'commit' }).workbook).map(([label]) => label);
    expect(labels).not.toContain('Collisions flagged');
    expect(labels).not.toContain('Orphan nodes flagged');
  });

  it('counts the detail rows for any count the summary lacks', () => {
    const summary = summaryOf(build({ results: { summary: {}, details: DETAILS } }).workbook);
    expect(summary.slice(5)).toEqual([
      ['Created', 1], ['Updated', 1], ['Needs review', 1], ['Errors', 1],
    ]);
  });

  it('formats the generated time as a zero-padded local date and time', () => {
    expect(localDateTime(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05 09:07');
  });
});

describe('file name', () => {
  it('is {move-slug}-from-to-{check|import}-{YYYY-MM-DD}.xlsx', () => {
    expect(build().filename).toBe('nap11-hall-migration-from-to-check-2026-09-25.xlsx');
    expect(build({ phase: 'commit' }).filename)
      .toBe('nap11-hall-migration-from-to-import-2026-09-25.xlsx');
  });

  it('slugs the move name', () => {
    expect(moveSlug('NAP11 Hall Migration')).toBe('nap11-hall-migration');
    expect(moveSlug('  --Dock #3 / Rack A--  ')).toBe('dock-3-rack-a');
    expect(moveSlug('Café Move')).toBe('caf-move');
    expect(moveSlug('a'.repeat(45))).toBe('a'.repeat(40));
    // cut at 40 lands on a dash: the dash is trimmed too
    expect(moveSlug(`${'x'.repeat(39)} yz`)).toBe('x'.repeat(39));
  });

  it('falls back to "move" when the slug is empty', () => {
    expect(moveSlug('')).toBe('move');
    expect(moveSlug('!!! ---')).toBe('move');
    expect(build({}, '').filename).toBe('move-from-to-check-2026-09-25.xlsx');
  });

  it('uses the local date from the clock, not the UTC date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const report = () =>
      buildImportReport({ job: job(), moveName: 'NAP11', generatedBy: 'J' }).filename;

    vi.setSystemTime(new Date(2026, 8, 25, 23, 30));   // late evening, local
    expect(report()).toBe('nap11-from-to-check-2026-09-25.xlsx');
    vi.setSystemTime(new Date(2026, 8, 26, 0, 30));    // just after local midnight
    expect(report()).toBe('nap11-from-to-check-2026-09-26.xlsx');
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});

describe('downloadImportReport', () => {
  it('hands the browser an .xlsx blob under the report file name', () => {
    const anchor = { href: '', download: '', click: vi.fn() };
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });

    downloadImportReport(build());

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blob.size).toBeGreaterThan(0);
    expect(anchor.download).toBe('nap11-hall-migration-from-to-check-2026-09-25.xlsx');
    expect(anchor.href).toBe('blob:report');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });
});
