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
const FIELDS = HEADERS.map((h) => h.toLowerCase().replace(/ /g, '_'));
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

describe('readWorkbook', () => {
  it('keeps sheet order and names, trims trailing blank rows, flags empty sheets', () => {
    const sheets = readWorkbook(xlsxBuffer({
      Second: [['a', 'b'], ['1', '2'], [], ['', '']],
      First: [],
      Third: [['x']],
    }));
    expect(sheets.map((s) => s.name)).toEqual(['Second', 'First', 'Third']);
    expect(sheets[0].rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(sheets[1].rows).toEqual([]);
    expect(sheetHasData(sheets[0])).toBe(true);
    expect(sheetHasData(sheets[1])).toBe(false);
    expect(sheetHasData({ name: 'blank', rows: [['', ''], ['']] })).toBe(false);
  });

  it('reads cells as text', () => {
    const ws = XLSX.utils.aoa_to_sheet([['n', 'v'], [0, 0]]);
    ws.A2 = { t: 'n', v: 45658, z: 'yyyy-mm-dd' };
    ws.B2 = { t: 'n', v: 123456789012 };
    ws.A3 = { t: 'n', v: 12.5 };
    ws.B3 = { t: 'b', v: true };
    ws.A4 = { t: 's', v: '  web-01 ' };
    ws['!ref'] = 'A1:B4';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: false }) as ArrayBuffer;
    const rows = readWorkbook(buf)[0].rows;
    expect(rows[1][0]).toBe('2025-01-01');
    expect(rows[1][1]).toBe('123456789012');
    expect(rows[2][0]).toBe('12.5');
    expect(rows[2][1]).toBe('TRUE');
    expect(rows[3][0]).toBe('web-01');
  });

  it('keeps CSV text as typed', () => {
    const buf = new TextEncoder().encode('Serial,Name\n00123,web-01\n').buffer as ArrayBuffer;
    expect(readWorkbook(buf)[0].rows).toEqual([['Serial', 'Name'], ['00123', 'web-01']]);
  });
});

describe('detectHeaderRow', () => {
  it('skips title and blank rows', () => {
    expect(detectHeaderRow([['Acme Corp move list'], [], ['Hostname', 'Serial'], ['a', 'b']])).toBe(2);
  });
  it('falls back to the first row', () => {
    expect(detectHeaderRow([['a'], ['b'], ['c']])).toBe(0);
  });
});

describe('sourceColumns', () => {
  it('names blank headers, drops empty ones, numbers duplicates, samples distinct values', () => {
    const rows = [
      ['Serial', '', '', 'serial', 'Serial'],
      ['s1', 'x', '', 's1', 'q'],
      ['s2', 'y', '', 's1', 'q'],
      ['s1', 'x', '', 's3', 'r'],
      ['s4', 'z', '', 's4', 's'],
      ['s5', '', '', 's5', 't'],
    ];
    const cols = sourceColumns(rows, 0);
    expect(cols.map((c) => c.header)).toEqual(
      ['Serial', 'Column B', 'serial (2)', 'Serial (3)']);
    expect(cols.map((c) => c.index)).toEqual([0, 1, 3, 4]);
    expect(cols[0].samples).toEqual(['s1', 's2', 's4']);
    expect(cols[1].samples).toEqual(['x', 'y', 'z']);
    expect(cols[2].samples).toEqual(['s1', 's3', 's4']);
  });

  it('numbers a duplicate exactly', () => {
    const cols = sourceColumns([['Serial', 'Serial'], ['a', 'b']], 0);
    expect(cols.map((c) => c.header)).toEqual(['Serial', 'Serial (2)']);
  });

  it('names a blank header with data Column C when it is the third column', () => {
    const cols = sourceColumns([['a', 'b', ''], ['1', '2', '3']], 0);
    expect(cols.map((c) => c.header)).toEqual(['a', 'b', 'Column C']);
  });
});

describe('normalize', () => {
  it('lowercases and collapses punctuation', () => {
    expect(normalize('S/N #')).toBe('s n');
  });
});

describe('keywordField', () => {
  const table: [string, string | null][] = [
    ['Hostname', 'asset_name'],
    ['S/N', 'serial_number'],
    ['Service Tag', 'serial_number'],
    ['EPC', 'rfid_tag'],
    ['Manufacturer', 'asset_make'],
    ['Vendor', 'asset_make'],
    ['Vendor Involved', 'vendor_involvement'],
    ['Model Name', 'asset_model'],
    ['Rack Name', 'source_rack'],
    ['From Cabinet', 'source_rack'],
    ['To Rack', 'destination_rack'],
    ['New U', 'destination_ru'],
    ['Rack Position', 'source_ru'],
    ['Dest Side', 'destination_position'],
    ['Pod', 'source_pod'],
    ['Data 3', 'data_3'],
    ['Management 2', 'mgmt_2'],
    ['Wave', 'priority'],
    ['Notes', null],
  ];
  it.each(table)('%s -> %s', (header, field) => {
    expect(keywordField(header)).toBe(field);
  });
});

const col = (index: number, header: string) => ({ index, header, samples: [] });

describe('suggestMapping', () => {
  it('exact beats keyword', () => {
    expect(suggestMapping([col(0, 'Hostname'), col(1, 'Asset Name')], TEMPLATE))
      .toEqual({ 1: 'Asset Name' });
  });
  it('gives each target to one column', () => {
    expect(suggestMapping([col(0, 'Serial'), col(1, 'Serial (2)')], TEMPLATE))
      .toEqual({ 0: 'Serial Number' });
  });
  it('matches Pod # to Source Pod by alias', () => {
    expect(suggestMapping([col(0, 'Pod #')], TEMPLATE)).toEqual({ 0: 'Source Pod' });
  });
});

describe('convertRows + convertedWorkbook', () => {
  const rows = [
    ['Acme list'],
    ['Host', 'S/N', 'Notes'],
    ['web-01', 'SN1', 'n1'],
    ['', '', ''],
    ['web-02', '', 'n2'],
  ];
  const cols = sourceColumns(rows, 1);
  const mapping = { 0: 'Asset Name', 1: 'Serial Number' };

  it('lays rows out in template order', () => {
    const conv = convertRows(rows, 1, cols, mapping, TEMPLATE);
    expect(conv.header).toEqual(HEADERS);
    expect(conv.rows).toHaveLength(2);
    expect(conv.rows[0]).toEqual(HEADERS.map((h) =>
      (h === 'Serial Number' ? 'SN1' : h === 'Asset Name' ? 'web-01' : '')));
    expect(conv.rows[1][0]).toBe('');
    expect(conv.rows[1][1]).toBe('web-02');
    expect(conv.blankRows).toBe(1);
    expect(conv.ignoredColumns).toBe(1);
  });

  it('builds a one-sheet workbook headed by every template header', () => {
    const conv = convertRows(rows, 1, cols, mapping, TEMPLATE);
    const wb = convertedWorkbook(conv);
    expect(wb.SheetNames).toEqual([CONVERTED_SHEET]);
    const out = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[CONVERTED_SHEET], { header: 1 });
    expect(out[0]).toEqual(HEADERS);
    expect(out[1][0]).toBe('SN1');
    expect(out[1][1]).toBe('web-01');
  });
});

describe('convertedFilename', () => {
  it('swaps the extension', () => {
    expect(convertedFilename('Acme FT v3.xlsx')).toBe('Acme FT v3-converted.xlsx');
    expect(convertedFilename('list.csv')).toBe('list-converted.xlsx');
    expect(convertedFilename('noext')).toBe('noext-converted.xlsx');
  });
});
