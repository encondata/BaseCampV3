// @vitest-environment jsdom
/**
 * Convert Raw F-T step 4 (eligible people only): pick a move, hand the
 * converted file to its From-To import page, and navigate there.
 * Spec: docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InitiativeItem, MoveAssetTemplateColumn } from '../../../lib/api';

const HEADERS = ['Serial Number', 'Asset Name', 'Destination Rack'];
const TEMPLATE: MoveAssetTemplateColumn[] = HEADERS.map((header, i) => ({
  header, field: header.toLowerCase().replace(/ /g, '_'), aliases: [header.toLowerCase()],
  required: i === 0, accepts: 'x', example: '',
}));

const apiMock = vi.hoisted(() => ({
  getMoveAssetTemplateColumns: vi.fn(), downloadMoveAssetTemplate: vi.fn(), listInitiatives: vi.fn(),
}));
vi.mock('../../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../../lib/api')>()), ...apiMock }));

const auth = vi.hoisted(() => ({ maxRank: 80, changeAllowed: true }));
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({
    maxRank: auth.maxRank,
    can: (resource: string, action: string) => (resource === 'initiatives' && action === 'change' ? auth.changeAllowed : true),
  }),
}));

const { default: BulkConvertRawFt } = await import('../../../pages/BulkConvertRawFt');
const { peekHandedOffImportFile, clearHandedOffImportFile } = await import('../../../lib/importHandoff');

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
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
beforeEach(() => {
  auth.maxRank = 80;
  auth.changeAllowed = true;
  apiMock.getMoveAssetTemplateColumns.mockResolvedValue(TEMPLATE);
  apiMock.listInitiatives.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const id of ['m1', 'm2', 'm3']) clearHandedOffImportFile(id);
});

const MAIN = [
  ['Hostname', 'S/N', 'To Rack'],
  ['web-01', 'SN1', 'R1'],
  ['web-02', 'SN2', 'R2'],
];

function workbookFile(): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(MAIN), 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'Acme FT.xlsx');
}

function initiative(over: Partial<InitiativeItem>): InitiativeItem {
  return {
    id: 'x', name: 'x', initiative_type: 'move', status_label: 'Planning',
    origin_site_name: null, destination_site_name: null, archived_at: null, ...over,
  } as InitiativeItem;
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const queryButton = (name: string) => screen.queryByRole('button', { name });

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/bulk/convert-raw-ft']}>
      <Routes>
        <Route path="/bulk/convert-raw-ft" element={<BulkConvertRawFt />} />
        <Route path="/initiatives/:id/import-assets" element={<div>import page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Drop your file here, or click to browse');
}

async function toDownload() {
  await renderPage();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [workbookFile()] } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  click('Next');
  await screen.findByRole('table', { name: 'Column matches' });
  click('Next');
  await screen.findByRole('table', { name: 'Converted preview' });
}

async function toImport() {
  await toDownload();
  click('Import into a move');
  await screen.findByRole('heading', { name: 'Step 4 of 4 · Choose the move' });
}

const moveCombo = () => screen.getByLabelText('Move') as HTMLInputElement;

function openMenu(): HTMLElement {
  fireEvent.focus(moveCombo());
  return document.querySelector('.combo-menu') as HTMLElement;
}

describe('who sees the import step', () => {
  it('rank 60 sees three steps and no Import button', async () => {
    auth.maxRank = 60;
    await toDownload();
    expect(screen.getByRole('heading', { name: 'Step 3 of 3 · Preview and download' })).toBeTruthy();
    expect(screen.queryByText('Import')).toBeNull();
    expect(queryButton('Import into a move')).toBeNull();
    expect(queryButton('Download converted file')).toBeTruthy();
  });

  it('rank 80 without initiatives:change sees three steps and no Import button', async () => {
    auth.changeAllowed = false;
    await toDownload();
    expect(screen.getByRole('heading', { name: 'Step 3 of 3 · Preview and download' })).toBeTruthy();
    expect(queryButton('Import into a move')).toBeNull();
  });

  it('rank 80 with initiatives:change sees four steps and the button', async () => {
    await toDownload();
    expect(screen.getByRole('heading', { name: 'Step 3 of 4 · Preview and download' })).toBeTruthy();
    for (const label of ['Upload', 'Match', 'Download', 'Import']) expect(screen.getByText(label)).toBeTruthy();
    expect(queryButton('Import into a move')).toBeTruthy();
  });

  it('the loading chrome shows four steps for an eligible person', async () => {
    apiMock.getMoveAssetTemplateColumns.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><BulkConvertRawFt /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Step 1 of 4 · Upload the raw F-T' })).toBeTruthy();
  });
});

describe('step 4 · Import', () => {
  it('shows the title, description, a Move combo and Loading moves… while loading', async () => {
    apiMock.listInitiatives.mockReturnValue(new Promise(() => {}));
    await toImport();
    expect(screen.getByText('Pick the move to import into. Its From-To import opens with the converted file already loaded.')).toBeTruthy();
    expect(screen.getByText('Loading moves…')).toBeTruthy();
    expect(moveCombo().placeholder).toBe('Pick a move…');
  });

  it('lists only unarchived moves in natural order with the status and sites sub line', async () => {
    apiMock.listInitiatives.mockResolvedValue([
      initiative({ id: 'm1', name: 'Move 10', status_label: 'Active', origin_site_name: 'Dallas', destination_site_name: 'Austin' }),
      initiative({ id: 'm2', name: 'Move 2', status_label: 'Planning' }),
      initiative({ id: 'm3', name: 'Old move', archived_at: '2026-01-01T00:00:00Z' }),
      initiative({ id: 'p1', name: 'A project', initiative_type: 'project' }),
    ]);
    await toImport();
    await waitFor(() => expect(screen.queryByText('Loading moves…')).toBeNull());
    const menu = openMenu();
    const options = within(menu).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options[0]).toContain('Move 2');
    expect(options[0]).toContain('Planning · — → —');
    expect(options[1]).toContain('Move 10');
    expect(options[1]).toContain('Active · Dallas → Austin');
  });

  it('says so when the moves cannot be loaded', async () => {
    apiMock.listInitiatives.mockRejectedValue(new Error('nope'));
    await toImport();
    expect(await screen.findByText("Couldn't load moves. Go back and try again.")).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Open the import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when there are no moves', async () => {
    apiMock.listInitiatives.mockResolvedValue([initiative({ id: 'p1', initiative_type: 'project' })]);
    await toImport();
    expect(await screen.findByText('There are no moves to import into.')).toBeTruthy();
  });

  it('Open the import is disabled until a move is picked, then hands off the file and navigates', async () => {
    apiMock.listInitiatives.mockResolvedValue([initiative({ id: 'm1', name: 'Move 1' })]);
    await toImport();
    await waitFor(() => expect(screen.queryByText('Loading moves…')).toBeNull());
    const open = screen.getByRole('button', { name: 'Open the import' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.mouseDown(within(openMenu()).getByText('Move 1'));
    expect(open.disabled).toBe(false);
    fireEvent.click(open);

    expect(await screen.findByText('import page')).toBeTruthy();
    const handed = peekHandedOffImportFile('m1')!;
    expect(handed.name).toBe('Acme FT-converted.xlsx');
    expect(handed.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const wb = XLSX.read(await handed.arrayBuffer(), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Move Assets']);
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Move Assets'], { header: 1, defval: '' });
    expect(aoa[0]).toEqual(HEADERS);
    expect(aoa[1]).toEqual(['SN1', 'web-01', 'R1']);
    expect(aoa[2]).toEqual(['SN2', 'web-02', 'R2']);
    expect(peekHandedOffImportFile('m2')).toBeNull();
  });

  it('Back returns to step 3', async () => {
    await toImport();
    click('Back');
    expect(await screen.findByRole('heading', { name: 'Step 3 of 4 · Preview and download' })).toBeTruthy();
  });
});
