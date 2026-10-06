// @vitest-environment jsdom
/**
 * useRawFtConvert — state and logic behind Convert Raw F-T: read a customer
 * workbook, suggest and edit the column matches, convert, and download.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MoveAssetTemplateColumn } from '../../../lib/api';
import { readWorkbook } from '../../../lib/ftConvert';

vi.mock('xlsx', async (orig) => ({ ...(await orig<typeof import('xlsx')>()), writeFile: vi.fn() }));

const { useRawFtConvert } = await import('./useRawFtConvert');

const HEADERS = ['Serial Number', 'Asset Name', 'Asset Make', 'Asset Model', 'RFID Tag',
  'Priority', 'Disposition', 'Owner', 'Source Pod', 'Source Rack', 'Source RU',
  'Source Position', 'Destination Pod', 'Destination Rack', 'Destination RU',
  'Destination Position', 'Data 1', 'Data 2', 'Data 3', 'Data 4', 'Data 5', 'Data 6',
  'Mgmt 1', 'Mgmt 2', 'Vendor Involvement'];
const TEMPLATE: MoveAssetTemplateColumn[] = HEADERS.map((header, i) => ({
  header, field: header.toLowerCase().replace(/ /g, '_'), aliases: [header.toLowerCase()],
  required: i === 0, accepts: 'x', example: '',
}));

beforeAll(() => {
  // jsdom's File has no arrayBuffer()
  if (!File.prototype.arrayBuffer) {
    File.prototype.arrayBuffer = function arrayBuffer(this: File) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(this);
      });
    };
  }
});
afterEach(() => { vi.mocked(XLSX.writeFile).mockClear(); });

const MAIN = [
  ['Hostname', 'S/N', 'To Rack', 'Notes'],
  ['web-01', 'SN1', 'R1', 'keep'],
  ['', '', '', ''],
  ['web-02', 'SN2', 'R2', ''],
];

function workbookFile(sheets: Record<string, unknown[][]>, name = 'Acme FT.xlsx'): File {
  const wb = XLSX.utils.book_new();
  for (const [n, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], name);
}

async function loaded(sheets: Record<string, unknown[][]> = { Sheet1: MAIN }) {
  const hook = renderHook(() => useRawFtConvert(TEMPLATE));
  const file = workbookFile(sheets);
  await act(async () => { await hook.result.current.onFile(file); });
  await waitFor(() => expect(hook.result.current.sheet).not.toBeNull());
  return hook;
}

describe('useRawFtConvert', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useRawFtConvert(TEMPLATE));
    expect(result.current.file).toBeNull();
    expect(result.current.sheet).toBeNull();
    expect(result.current.conversion).toBeNull();
    expect(result.current.matched).toBe(0);
  });

  it('onFile loads the first data sheet with its header row and the suggestions', async () => {
    const { result } = await loaded({ Empty: [], Sheet1: MAIN });
    expect(result.current.sheetName).toBe('Sheet1');
    expect(result.current.sheets.map((s) => s.name)).toEqual(['Sheet1']);
    expect(result.current.headerRow).toBe(1);
    expect(result.current.headerText).toBe('1');
    expect(result.current.columns.map((c) => c.header)).toEqual(['Hostname', 'S/N', 'To Rack', 'Notes']);
    expect(result.current.mapping).toEqual({ 0: 'Asset Name', 1: 'Serial Number', 2: 'Destination Rack' });
    expect(result.current.suggested).toEqual(result.current.mapping);
    expect(result.current.matched).toBe(3);
    expect(result.current.serialMatched).toBe(true);
    expect(result.current.conversion?.rows).toHaveLength(2);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('');
  });

  it('skips a title row above the headers', async () => {
    const { result } = await loaded({ Sheet1: [['Acme move list'], ...MAIN] });
    expect(result.current.headerRow).toBe(2);
    act(() => result.current.changeHeaderRow('1'));
    expect(result.current.columns[0].header).toBe('Acme move list');
  });

  it('reports a file with no data', async () => {
    const hook = renderHook(() => useRawFtConvert(TEMPLATE));
    await act(async () => { await hook.result.current.onFile(workbookFile({ Sheet1: [] })); });
    expect(hook.result.current.error).toBe('That file has no data.');
    expect(hook.result.current.sheet).toBeNull();
  });

  it('setTarget, clearAll and useSuggestions edit the matches', async () => {
    const { result } = await loaded();
    act(() => result.current.setTarget(0, 'Owner'));
    expect(result.current.mapping[0]).toBe('Owner');
    expect(result.current.usedHeaders.has('Owner')).toBe(true);
    act(() => result.current.setTarget(0, ''));
    expect(result.current.mapping[0]).toBeUndefined();
    act(() => result.current.clearAll());
    expect(result.current.mapping).toEqual({});
    expect(result.current.matched).toBe(0);
    expect(result.current.serialMatched).toBe(false);
    expect(result.current.previewColumns).toEqual([]);
    act(() => result.current.useSuggestions());
    expect(result.current.mapping).toEqual(result.current.suggested);
    expect(result.current.matched).toBe(3);
  });

  it('download writes the converted workbook with compression', async () => {
    const { result } = await loaded();
    act(() => result.current.download());
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [, filename, opts] = vi.mocked(XLSX.writeFile).mock.calls[0] as [XLSX.WorkBook, string, XLSX.WritingOptions];
    expect(filename).toBe('Acme FT-converted.xlsx');
    expect(opts).toEqual({ compression: true });
  });

  it('toFile is null before a file is read', () => {
    const { result } = renderHook(() => useRawFtConvert(TEMPLATE));
    expect(result.current.toFile()).toBeNull();
  });

  it('toFile returns the converted workbook as a named xlsx File', async () => {
    const { result } = await loaded();
    const out = result.current.toFile();
    expect(out).toBeInstanceOf(File);
    expect(out!.name).toBe('Acme FT-converted.xlsx');
    expect(out!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const back = readWorkbook(await out!.arrayBuffer());
    expect(back).toHaveLength(1);
    const { header, rows } = result.current.conversion!;
    expect(back[0].rows[0]).toEqual(header);
    expect(back[0].rows.slice(1).map((r) => header.map((_, i) => r[i] ?? '')))
      .toEqual(rows);
  });

  it('download does nothing before a file is read', () => {
    const { result } = renderHook(() => useRawFtConvert(TEMPLATE));
    act(() => result.current.download());
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });

  it('reset clears the file, sheets, mapping and suggestions', async () => {
    const { result } = await loaded();
    act(() => result.current.reset());
    expect(result.current.file).toBeNull();
    expect(result.current.sheets).toEqual([]);
    expect(result.current.sheet).toBeNull();
    expect(result.current.mapping).toEqual({});
    expect(result.current.suggested).toEqual({});
    expect(result.current.conversion).toBeNull();
    expect(result.current.error).toBe('');
    expect(result.current.busy).toBe(false);
  });

  it('reset clears the file input value', async () => {
    const { result } = await loaded();
    const input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'value', { value: 'C:\\fakepath\\Acme FT.xlsx', writable: true, configurable: true });
    (result.current.inputRef as { current: HTMLInputElement | null }).current = input;
    act(() => result.current.reset());
    expect(input.value).toBe('');
  });
});
