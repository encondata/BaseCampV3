// portal/src/pages/PrintLabels.test.tsx
// @vitest-environment jsdom
/**
 * /labels/print — wiring of the five-step flow with the API, the printer
 * hook, and the offline cache all mocked: picker filter + summary, type
 * coverage, printer card states, selection → print validation, the
 * inline print path (settings applied, blanks in rack mode), the batch
 * modal path, settings persistence, and the offline fallback.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem, LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), listInitiativeAssets: vi.fn(), listLabelVocab: vi.fn(), getGeneratedLabelBundle: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const printer = vi.hoisted(() => ({
  supported: true, connected: false, productName: null as string | null, notice: null,
  clearNotice: vi.fn(), connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
  send: vi.fn(async (_zpl: string) => undefined), waitForIdle: vi.fn(async (_n: number, onQueued?: (q: number) => void) => { onQueued?.(0); }),
}));
vi.mock('../lib/useZebraPrinter', () => ({ useZebraPrinter: () => printer }));

const cache = vi.hoisted(() => {
  const inis = new Map<string, unknown>();
  const bundles = new Map<string, unknown>();
  return {
    inis, bundles,
    cacheAvailable: () => true,
    bundleKey: (i: string, t: string) => `${i}:${t}`,
    putInitiative: vi.fn(async (e: { initiative: { id: string } }) => { inis.set(e.initiative.id, { ...e, cached_at: new Date().toISOString() }); }),
    getInitiative: vi.fn(async (id: string) => inis.get(id) ?? null),
    listInitiatives: vi.fn(async () => Array.from(inis.values())),
    putBundle: vi.fn(async (b: { initiative_id: string; label_type: string }, name: string) => { bundles.set(`${b.initiative_id}:${b.label_type}`, { ...b, initiative_name: name, cached_at: new Date().toISOString() }); }),
    getBundle: vi.fn(async (i: string, t: string) => bundles.get(`${i}:${t}`) ?? null),
    listBundles: vi.fn(async () => Array.from(bundles.values())),
    deleteBundle: vi.fn(async (i: string, t: string) => { bundles.delete(`${i}:${t}`); }),
    deleteInitiative: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => { inis.clear(); bundles.clear(); }),
  };
});
vi.mock('../lib/labelCache', () => cache);

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_prefs: {} }, updatePreferences: vi.fn(async () => true) }),
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: PrintLabels } = await import('./PrintLabels');

const ini = (id: string, name: string, status = 'planned'): InitiativeItem => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: 'move', type_label: 'Move',
  type_color: '#000', client_name: 'Acme', archived_at: null, scheduled_start: '2026-10-01T00:00:00Z',
  scheduled_end: null, origin_site_name: 'NAP11', destination_site_name: 'NAP22', created_at: '2026-09-01T00:00:00Z',
} as unknown as InitiativeItem);

const row = (n: number, rack: string, ru: number): InitiativeAssetRow => ({
  id: `j${n}`, asset_id: `a${n}`, source_rack: rack, source_ru: ru, status: 'planned', status_label: 'Planned',
  status_color: '#123', asset: { id: `a${n}`, legacy_id: 38000 + n, serial_number: `SN${n}`, name: `asset-${n}`, model_make: 'Dell', model_name: 'R740' },
} as unknown as InitiativeAssetRow);

const vocab: LabelVocab[] = [
  { kind: 'type', key: 'top', label: 'Top Label', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'type', key: 'front', label: 'Front Label', description: '', meta: {}, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'type', key: 'container', label: 'Container Label', description: '', meta: {}, sort_order: 4, is_active: true, usage_count: null },
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

const bundleFor = (ids: string[], type = 'top'): GeneratedLabelBundle => ({
  initiative_id: 'i1', label_type: type, fetched_at: 'now',
  labels: ids.map((id) => ({
    id: `g-${id}`, entity_type: 'asset', entity_id: id, template_id: 't', template_name: 'T', template_version: 1,
    language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: `^XA^PW812^FD${id}^FS^XZ`,
  })),
});

const ROWS = [row(1, 'R1', 40), row(2, 'R1', 42), row(3, 'R2', 10)];

beforeEach(() => {
  localStorage.clear();
  cache.inis.clear(); cache.bundles.clear();
  printer.connected = false; printer.productName = null; printer.send.mockClear(); printer.connect.mockClear();
  api.listInitiatives.mockResolvedValue([ini('i1', 'NAP11'), ini('i2', 'Done move', 'completed')]);
  api.listLabelVocab.mockResolvedValue(vocab);
  api.listInitiativeAssets.mockResolvedValue(ROWS);
  api.getGeneratedLabelBundle.mockImplementation(async (_i: string, t: string) => bundleFor(t === 'top' ? ['a1', 'a2', 'a3'] : ['a1'], t));
});
afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><PrintLabels /></MemoryRouter>);

async function pickInitiative() {
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  await userEvent.click(await screen.findByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
}

it('renders the header, hides finished initiatives, and shows the summary + coverage after a pick', async () => {
  renderPage();
  expect(screen.getByText('Print Labels')).toBeTruthy();
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  expect(await screen.findByText('NAP11')).toBeTruthy();
  expect(screen.queryByText('Done move')).toBeNull();
  await userEvent.click(screen.getByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
  expect(screen.getByText('3 assets')).toBeTruthy();
  expect(screen.getByText('3 of 3 assets have a Top Label')).toBeTruthy();
  expect(screen.queryByText('Container Label')).toBeNull();
  expect(cache.putInitiative).toHaveBeenCalled();
  expect(cache.putBundle).toHaveBeenCalled();
});

it('switching to Front shows its coverage and Custom reveals the raw ZPL box', async () => {
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('radio', { name: /Front Label/ }));
  expect(await screen.findByText('1 of 3 assets have a Front Label · 2 missing')).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: /Custom/ }));
  expect(screen.getByLabelText('Raw ZPL')).toBeTruthy();
});

it('printer card: connect button calls the hook; unsupported browsers get an explanation', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  expect(printer.connect).toHaveBeenCalledTimes(1);
  cleanup();
  printer.supported = false;
  renderPage();
  expect(screen.getByText('USB printing needs Chrome or Edge on a secure (https or localhost) address.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect via USB' })).toBeNull();
  printer.supported = true;
});

it('Print is gated and prints selected labels in display order with settings applied', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  renderPage();
  await pickInitiative();
  const print = screen.getByRole('button', { name: /^Print \d/ }) as HTMLButtonElement;
  expect(print.disabled).toBe(true);
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  expect(screen.getByRole('button', { name: 'Print 3 labels' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  await waitFor(() => expect(printer.send).toHaveBeenCalledTimes(3));
  // default sort is Source rack asc with RU top-down: a2 (R1/42), a1 (R1/40), a3 (R2/10)
  expect(printer.send.mock.calls.map((c) => c[0])).toEqual([
    '^XA^PW812^FDa2^FS^XZ', '^XA^PW812^FDa1^FS^XZ', '^XA^PW812^FDa3^FS^XZ',
  ]);
  expect(await screen.findByText('Successfully printed 3 label(s)')).toBeTruthy();
});

it('applies offsets/copies from saved settings and feeds blanks between racks in rack mode', async () => {
  localStorage.setItem('labels.print.settings', JSON.stringify({ horizontalOffset: 10, copies: 2, printByRack: true, blanksBetweenRacks: 2 }));
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  await waitFor(() => expect(printer.send).toHaveBeenCalledTimes(4));
  const sent = printer.send.mock.calls.map((c) => c[0]);
  expect(sent[0]).toBe('^XA\n^LS-10^PW822^FDa2^FS^PQ2^XZ');
  expect(sent[1]).toBe('^XA\n^LS-10^PW822^FDa1^FS^PQ2^XZ');
  // rack change R1 → R2: 2 blanks; offsets still apply (V2 ran blanks through the same transform), copies do NOT
  expect(sent[2]).toBe('^XA\n^LS-10^FO10,10^A0N,10,10^FD ^FS^PQ2^XZ');
  expect(sent[3]).toBe('^XA\n^LS-10^PW822^FDa3^FS^PQ2^XZ');
});

it('blocks printing when selected assets lack labels and offers Deselect missing', async () => {
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('radio', { name: /Front Label/ }));
  await screen.findByText('1 of 3 assets have a Front Label · 2 missing');
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('2 selected asset(s) do not have Front Label data. Please generate labels first.')).toBeTruthy();
  expect(printer.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Deselect missing' }));
  expect(screen.getByRole('button', { name: 'Print 1 label' })).toBeTruthy();
});

it('opens the batch modal above the batch size and walks batches', async () => {
  localStorage.setItem('labels.print.settings', JSON.stringify({ batchSize: 2 }));
  printer.connected = true;
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByLabelText('Select all filtered assets'));
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('Printing labels')).toBeTruthy();
  expect(await screen.findByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
  expect(printer.send).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Print next batch (1 labels)' }));
  expect(await screen.findByText('All 3 labels printed successfully!')).toBeTruthy();
  expect(printer.send).toHaveBeenCalledTimes(3);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByText('Printing labels')).toBeNull();
  expect(screen.getByText('Successfully printed 3 label(s)')).toBeTruthy();
});

it('settings modal edits persist to localStorage and mark the gear', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Print settings' }));
  const copies = screen.getByLabelText('Copies');
  fireEvent.change(copies, { target: { value: '4' } });
  fireEvent.blur(copies);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(JSON.parse(localStorage.getItem('labels.print.settings') ?? '{}').copies).toBe(4);
  expect(screen.getByRole('button', { name: 'Print settings' }).querySelector('.plabels-modified')).toBeTruthy();
});

it('falls back to the cache with an offline banner when the API fails', async () => {
  cache.inis.set('i1', { initiative: ini('i1', 'NAP11'), roster: ROWS, cached_at: new Date().toISOString() });
  cache.bundles.set('i1:top', { ...bundleFor(['a1', 'a2', 'a3']), initiative_name: 'NAP11', cached_at: new Date().toISOString() });
  api.listInitiatives.mockRejectedValue(new TypeError('Failed to fetch'));
  api.listInitiativeAssets.mockRejectedValue(new TypeError('Failed to fetch'));
  api.getGeneratedLabelBundle.mockRejectedValue(new TypeError('Failed to fetch'));
  renderPage();
  await userEvent.click(screen.getByPlaceholderText('Choose an initiative…'));
  await userEvent.click(await screen.findByText('NAP11'));
  await screen.findByText('Showing 3 of 3 assets');
  expect(screen.getByText(/Offline — using labels downloaded/)).toBeTruthy();
  expect(screen.getByText('3 of 3 assets have a Top Label')).toBeTruthy();
});

it('offline cache modal lists bundles and downloads the checked types', async () => {
  renderPage();
  await pickInitiative();
  await userEvent.click(screen.getByRole('button', { name: /Offline cache/ }));
  expect(await screen.findByText('Offline labels')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(api.getGeneratedLabelBundle).toHaveBeenCalledWith('i1', 'front'));
  expect(await screen.findByText(/Cached 2 types/)).toBeTruthy();
});
