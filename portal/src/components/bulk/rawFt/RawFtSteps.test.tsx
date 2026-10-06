// @vitest-environment jsdom
/**
 * Convert Raw F-T through its three steps (pages/BulkConvertRawFt): read a
 * customer workbook in the browser, match its columns to our From-To
 * template, preview, and download the converted .xlsx.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MoveAssetTemplateColumn } from '../../../lib/api';

vi.mock('xlsx', async (orig) => ({ ...(await orig<typeof import('xlsx')>()), writeFile: vi.fn() }));

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

const apiMock = vi.hoisted(() => ({ getMoveAssetTemplateColumns: vi.fn(), downloadMoveAssetTemplate: vi.fn() }));
vi.mock('../../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../../lib/api')>()), ...apiMock }));

const { default: BulkConvertRawFt } = await import('../../../pages/BulkConvertRawFt');
const { useRawFtConvert } = await import('./useRawFtConvert');
const { default: UploadStep } = await import('./UploadStep');
const { default: MatchStep } = await import('./MatchStep');
const { default: DownloadStep } = await import('./DownloadStep');

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

const nextButton = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** Render the page at step 1, with no file yet. */
async function open() {
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue(TEMPLATE);
  render(<BulkConvertRawFt />);
  await screen.findByText('Drop your file here, or click to browse');
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

/** Choose a file on step 1 and wait until it is read (Next enabled). */
async function chooseFile(file: File) {
  const input = await open();
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(nextButton().disabled).toBe(false));
}

/** Choose a file and go to step 2. */
async function toMatch(file: File) {
  await chooseFile(file);
  click('Next');
  await screen.findByRole('table', { name: 'Column matches' });
}

/** Choose a file and go to step 3. */
async function toDownload(file: File) {
  await toMatch(file);
  click('Next');
  await screen.findByRole('table', { name: 'Converted preview' });
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

describe('step 1 · Upload', () => {
  it('shows Reading the file… while the file is being read, then enables Next', async () => {
    const input = await open();
    const file = workbookFile({ Sheet1: MAIN });
    let release!: (b: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((r) => { release = r; });
    Object.defineProperty(file, 'arrayBuffer', { value: () => pending });
    const real = await workbookFile({ Sheet1: MAIN }).arrayBuffer();
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Reading the file…')).toBeTruthy();
    expect(input.disabled).toBe(true);
    expect(nextButton().disabled).toBe(true);
    release(real);
    await waitFor(() => expect(nextButton().disabled).toBe(false));
    expect(screen.queryByText('Reading the file…')).toBeNull();
    expect(input.disabled).toBe(false);
    expect(screen.getByLabelText('Header row')).toBeTruthy();
  });

  it('shows a Sheet picker only for a workbook with two data sheets, and re-reads on change', async () => {
    await chooseFile(workbookFile({
      First: [['Alpha', 'Beta'], ['1', '2']],
      Empty: [],
      Second: MAIN,
    }));
    const sheet = screen.getByLabelText('Sheet');
    expect(optionsOf(sheet)).toEqual(['First', 'Second']);
    click('Next');
    await screen.findByRole('table', { name: 'Column matches' });
    expect(within(matches()).getByText('Alpha')).toBeTruthy();
    click('Back');
    pick(screen.getByLabelText('Sheet'), 'Second');
    click('Next');
    await waitFor(() => expect(within(matches()).getByText('Hostname')).toBeTruthy());
    expect(within(matches()).queryByText('Alpha')).toBeNull();
  });

  it('has no Sheet control for a one-sheet workbook', async () => {
    await chooseFile(workbookFile({ Sheet1: MAIN }));
    expect(screen.queryByLabelText('Sheet')).toBeNull();
  });

  it('skips a title row above the headers, and re-reads when Header row changes', async () => {
    await chooseFile(workbookFile({ Sheet1: [['Acme move list'], ...MAIN] }));
    const input = screen.getByLabelText('Header row') as HTMLInputElement;
    expect(input.value).toBe('2');
    click('Next');
    await screen.findByRole('table', { name: 'Column matches' });
    expect(within(matches()).getByText('Hostname')).toBeTruthy();
    click('Back');
    fireEvent.change(screen.getByLabelText('Header row'), { target: { value: '1' } });
    click('Next');
    expect(within(matches()).getByText('Acme move list')).toBeTruthy();
    expect(within(matches()).queryByText('Hostname')).toBeNull();
  });

  it('reports a file with no data and keeps Next disabled', async () => {
    const input = await open();
    fireEvent.change(input, { target: { files: [workbookFile({ Sheet1: [] })] } });
    expect(await screen.findByText('That file has no data.')).toBeTruthy();
    expect(nextButton().disabled).toBe(true);
  });
});

describe('step 2 · Match', () => {
  it('lists each customer column with samples and pre-fills suggestions with a Suggested chip', async () => {
    await toMatch(workbookFile({ Sheet1: MAIN }));
    expect(screen.getByRole('heading', { name: 'Step 2 of 3 · Match columns' })).toBeTruthy();
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
    await toMatch(workbookFile({ Sheet1: MAIN }));
    expect(optionsOf(comboOf('Notes'))).not.toContain('Asset Name');
    expect(optionsOf(comboOf('Notes'))).toContain('Owner');
    pick(comboOf('Hostname'), 'Skip');
    expect(optionsOf(comboOf('Notes'))).toContain('Asset Name');
  });

  it('removes the Suggested chip when the row is changed', async () => {
    await toMatch(workbookFile({ Sheet1: MAIN }));
    pick(comboOf('Hostname'), 'Owner');
    expect(within(rowOf('Hostname')).queryByText('Suggested')).toBeNull();
    expect((comboOf('Hostname') as HTMLInputElement).value).toBe('Owner');
    click('Use suggestions');
    expect(within(rowOf('Hostname')).getByText('Suggested')).toBeTruthy();
  });

  it("warns when Serial Number isn't matched, and not when it is", async () => {
    const note = "Serial Number isn't matched. Turn on Generate serials when you import, or the rows will be rejected.";
    await toMatch(workbookFile({ Sheet1: MAIN }));
    expect(screen.queryByText(note)).toBeNull();
    pick(comboOf('S/N'), 'Skip');
    expect(screen.getByText(note)).toBeTruthy();
  });

  it('disables Next after Clear all, and enables it again with Use suggestions', async () => {
    await toMatch(workbookFile({ Sheet1: MAIN }));
    expect(nextButton().disabled).toBe(false);
    click('Clear all');
    expect(nextButton().disabled).toBe(true);
    expect(screen.getByText('0 of 4 columns matched')).toBeTruthy();
    click('Use suggestions');
    expect(nextButton().disabled).toBe(false);
  });
});

describe('step 3 · Download', () => {
  it('shows the converted counts and preview', async () => {
    await toDownload(workbookFile({ Sheet1: MAIN }));
    expect(screen.getByRole('heading', { name: 'Step 3 of 3 · Preview and download' })).toBeTruthy();
    expect(screen.getByText('2 rows converted · 1 blank rows dropped · 1 of their columns ignored')).toBeTruthy();
    const preview = screen.getByRole('table', { name: 'Converted preview' });
    expect(within(preview).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Serial Number', 'Asset Name', 'Destination Rack']);
    expect(within(preview).getByText('web-02')).toBeTruthy();
    expect(screen.getByText("Import it from a move's Import assets page or in Create a move in steps.")).toBeTruthy();
  });

  it('downloads Acme FT-converted.xlsx with one Move Assets sheet', async () => {
    await toDownload(workbookFile({ Sheet1: MAIN }));
    click('Download converted file');
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [wb, filename, opts] = vi.mocked(XLSX.writeFile).mock.calls[0] as [XLSX.WorkBook, string, XLSX.WritingOptions];
    expect(filename).toBe('Acme FT-converted.xlsx');
    expect(opts).toEqual({ compression: true });
    expect(wb.SheetNames).toEqual(['Move Assets']);
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Move Assets'], { header: 1, defval: '' });
    expect(aoa[0]).toEqual(HEADERS);
    expect(aoa[1][0]).toBe('SN1');
    expect(aoa[1][1]).toBe('web-01');
    expect(aoa[1][13]).toBe('R1');
    expect(aoa).toHaveLength(3);
  });

  it('keeps a manual match when going Back from step 3 to step 2', async () => {
    await toDownload(workbookFile({ Sheet1: MAIN }));
    click('Back');
    await screen.findByRole('table', { name: 'Column matches' });
    pick(comboOf('Hostname'), 'Owner');
    click('Next');
    await screen.findByRole('table', { name: 'Converted preview' });
    click('Back');
    await screen.findByRole('table', { name: 'Column matches' });
    expect((comboOf('Hostname') as HTMLInputElement).value).toBe('Owner');
    expect(within(rowOf('Hostname')).queryByText('Suggested')).toBeNull();
  });

  it('Start over returns to step 1 with no file', async () => {
    await toDownload(workbookFile({ Sheet1: MAIN }));
    click('Start over');
    expect(await screen.findByRole('heading', { name: 'Step 1 of 3 · Upload the raw F-T' })).toBeTruthy();
    expect(screen.getByText('Drop your file here, or click to browse')).toBeTruthy();
    expect(screen.queryByLabelText('Header row')).toBeNull();
    expect(nextButton().disabled).toBe(true);
  });

  it('shows the preview empty text, not cell-less rows, when nothing is matched', async () => {
    // Unreachable through the page (Next is disabled with no matches), so drive the steps directly.
    function Harness() {
      const convert = useRawFtConvert(TEMPLATE);
      return (
        <>
          <UploadStep convert={convert} template={TEMPLATE} />
          {convert.sheet && <MatchStep convert={convert} template={TEMPLATE} />}
          <DownloadStep convert={convert} />
        </>
      );
    }
    render(<Harness />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [workbookFile({ Sheet1: MAIN })] } });
    await screen.findByRole('table', { name: 'Column matches' });
    click('Clear all');
    expect(screen.getByText('Match at least one column to see the converted rows.')).toBeTruthy();
    const preview = screen.getByRole('table', { name: 'Converted preview' });
    expect(preview.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});
