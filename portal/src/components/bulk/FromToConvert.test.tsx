// @vitest-environment jsdom
/**
 * FromToConvert — the Upload pane of /bulk/from-to-convert: read a customer
 * workbook in the browser, match its columns to our From-To template,
 * preview, and download the converted .xlsx.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MoveAssetTemplateColumn } from '../../lib/api';

vi.mock('xlsx', async (orig) => ({ ...(await orig<typeof import('xlsx')>()), writeFile: vi.fn() }));

const { default: FromToConvert } = await import('./FromToConvert');

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

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
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
afterEach(() => { cleanup(); vi.mocked(XLSX.writeFile).mockClear(); });

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

async function upload(file: File) {
  render(<FromToConvert columns={TEMPLATE} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByRole('table', { name: 'Column matches' });
}

const matches = () => screen.getByRole('table', { name: 'Column matches' });
const rowOf = (header: string) => within(matches()).getByText(header).closest('tr') as HTMLElement;
const comboOf = (header: string) => screen.getByLabelText(`Our column for ${header}`);

function optionsOf(input: HTMLElement): string[] {
  fireEvent.focus(input);
  const menu = document.querySelector('.combo-menu') as HTMLElement;
  const labels = within(menu).getAllByRole('button').map((b) => b.textContent ?? '');
  fireEvent.keyDown(input, { key: 'Escape' });
  return labels;
}

function pick(input: HTMLElement, label: string) {
  fireEvent.focus(input);
  const menu = document.querySelector('.combo-menu') as HTMLElement;
  fireEvent.mouseDown(within(menu).getByText(label));
}

describe('FromToConvert', () => {
  it('lists each customer column with samples and pre-fills suggestions with a Suggested chip', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    const host = rowOf('Hostname');
    expect(within(host).getByText('web-01 · web-02')).toBeTruthy();
    expect((comboOf('Hostname') as HTMLInputElement).value).toBe('Asset Name');
    expect((comboOf('S/N') as HTMLInputElement).value).toBe('Serial Number');
    expect((comboOf('To Rack') as HTMLInputElement).value).toBe('Destination Rack');
    expect((comboOf('Notes') as HTMLInputElement).value).toBe('Skip');
    expect(within(host).getByText('Suggested')).toBeTruthy();
    expect(within(rowOf('Notes')).queryByText('Suggested')).toBeNull();
    expect(screen.getByText('3 of 4 columns matched')).toBeTruthy();
  });

  it('does not offer a target already picked by another row; Skip frees it again', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    expect(optionsOf(comboOf('Notes'))).not.toContain('Asset Name');
    expect(optionsOf(comboOf('Notes'))).toContain('Owner');
    pick(comboOf('Hostname'), 'Skip');
    expect(optionsOf(comboOf('Notes'))).toContain('Asset Name');
  });

  it('removes the Suggested chip when the row is changed', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    pick(comboOf('Hostname'), 'Owner');
    expect(within(rowOf('Hostname')).queryByText('Suggested')).toBeNull();
    expect((comboOf('Hostname') as HTMLInputElement).value).toBe('Owner');
    fireEvent.click(screen.getByRole('button', { name: 'Use suggestions' }));
    expect(within(rowOf('Hostname')).getByText('Suggested')).toBeTruthy();
  });

  it("warns when Serial Number isn't matched, and not when it is", async () => {
    const note = "Serial Number isn't matched. Turn on Generate serials when you import, or the rows will be rejected.";
    await upload(workbookFile({ Sheet1: MAIN }));
    expect(screen.queryByText(note)).toBeNull();
    pick(comboOf('S/N'), 'Skip');
    expect(screen.getByText(note)).toBeTruthy();
  });

  it('shows the converted counts', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    expect(screen.getByText('2 rows converted · 1 blank rows dropped · 1 of their columns ignored')).toBeTruthy();
    const preview = screen.getByRole('table', { name: 'Converted preview' });
    expect(within(preview).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Serial Number', 'Asset Name', 'Destination Rack']);
    expect(within(preview).getByText('web-02')).toBeTruthy();
  });

  it('downloads Acme FT-converted.xlsx with one Move Assets sheet, and disables after Clear all', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    fireEvent.click(screen.getByRole('button', { name: 'Download converted file' }));
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [wb, filename] = vi.mocked(XLSX.writeFile).mock.calls[0] as [XLSX.WorkBook, string];
    expect(filename).toBe('Acme FT-converted.xlsx');
    expect(wb.SheetNames).toEqual(['Move Assets']);
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Move Assets'], { header: 1, defval: '' });
    expect(aoa[0]).toEqual(HEADERS);
    expect(aoa[1][0]).toBe('SN1');
    expect(aoa[1][1]).toBe('web-01');
    expect(aoa[1][13]).toBe('R1');
    expect(aoa).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect((screen.getByRole('button', { name: 'Download converted file' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('0 of 4 columns matched')).toBeTruthy();
  });

  it('shows a Sheet picker only for a workbook with two data sheets, and re-reads on change', async () => {
    await upload(workbookFile({
      First: [['Alpha', 'Beta'], ['1', '2']],
      Empty: [],
      Second: MAIN,
    }));
    expect(within(matches()).getByText('Alpha')).toBeTruthy();
    const sheet = screen.getByLabelText('Sheet');
    expect(optionsOf(sheet)).toEqual(['First', 'Second']);
    pick(sheet, 'Second');
    await waitFor(() => expect(within(matches()).getByText('Hostname')).toBeTruthy());
    expect(within(matches()).queryByText('Alpha')).toBeNull();
  });

  it('has no Sheet control for a one-sheet workbook', async () => {
    await upload(workbookFile({ Sheet1: MAIN }));
    expect(screen.queryByLabelText('Sheet')).toBeNull();
  });

  it('skips a title row above the headers, and re-reads when Header row changes', async () => {
    await upload(workbookFile({ Sheet1: [['Acme move list'], ...MAIN] }));
    const input = screen.getByLabelText('Header row') as HTMLInputElement;
    expect(input.value).toBe('2');
    expect(within(matches()).getByText('Hostname')).toBeTruthy();
    fireEvent.change(input, { target: { value: '1' } });
    expect(within(matches()).getByText('Acme move list')).toBeTruthy();
    expect(within(matches()).queryByText('Hostname')).toBeNull();
  });

  it('reports a file with no data', async () => {
    render(<FromToConvert columns={TEMPLATE} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [workbookFile({ Sheet1: [] })] } });
    expect(await screen.findByText('That file has no data.')).toBeTruthy();
  });
});
