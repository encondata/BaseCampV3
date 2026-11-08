// @vitest-environment jsdom
/** Bulk Print against a real (fake) IndexedDB move, a fake station
 *  printer and stubbed label routes: the label types, the move's list with
 *  each row's label status at the saved printer's DPI, the printer line,
 *  the offline fallback and the move/type races. */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readPrintSettings } from '@portal/lib/printLabels';

import type { FakeStation } from './bulkPrintTestHarness';

const api = vi.hoisted(() => ({ fetchLabelVocab: vi.fn(), fetchKioskLabelBundle: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

const station = vi.hoisted(() => ({
  state: 'ready', sent: [], sendError: null, settings: null,
  connectUsb: vi.fn(async () => undefined),
  waitForIdle: vi.fn(async () => undefined),
}) as unknown as FakeStation);
vi.mock('../lib/useStationPrinter', async () => (
  (await import('./bulkPrintTestHarness')).stationPrinterModule(station)));

vi.mock('../auth/KioskAuthContext', () => ({
  useKioskAuth: () => ({ status: 'authed', preferences: { list_size: 'default' }, can: () => true }),
}));

import { ApiError } from '../lib/api';
import { putCachedBundle } from '../lib/bundleCache';
import { writeKioskSetup } from '../lib/kioskSetup';
import { writeMeta } from '../lib/localDb';
import BulkPrint from './BulkPrint';
import {
  bundle, byFullText, deferred, findRow, label, labelChip, queryRow, resetStation, seedMove,
  setupFor, typeCard, typeCardTitles, VOCAB, writeSyncedRows,
} from './bulkPrintTestHarness';

beforeEach(async () => {
  await seedMove('i-1');
  resetStation(station);
  api.fetchLabelVocab.mockReset().mockResolvedValue(VOCAB);
  api.fetchKioskLabelBundle.mockReset().mockImplementation(async (id: string, type: string) => (
    bundle(type, type === 'top' ? [label('a-1')] : [], id)));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

const render_ = () => render(<MemoryRouter><BulkPrint /></MemoryRouter>);

it("a type's labels load and the list shows Ready and Missing", async () => {
  render_();
  await waitFor(async () => expect(labelChip(await findRow('Rack A01 server'))).toBe('Ready'));
  expect(labelChip(await findRow('Spare switch'))).toBe('Missing');
  expect(api.fetchKioskLabelBundle).toHaveBeenCalledWith('i-1', 'top');
  const titles = typeCardTitles();
  expect(titles).toContain('Top Label');
  expect(titles).toContain('Custom');
  expect(titles).not.toContain('ID Badge');
  expect(screen.getByRole('heading', { name: 'Bulk Print' })).toBeTruthy();
  expect(screen.getByText('Move i-1 · ACC4')).toBeTruthy();
});

it('labels at another DPI count as missing', async () => {
  api.fetchKioskLabelBundle.mockImplementation(async (id: string, type: string) => (
    bundle(type, [label('a-1'), label('a-2', '300')], id)));
  render_();
  await waitFor(async () => expect(labelChip(await findRow('Rack A01 server'))).toBe('Ready'));
  expect(labelChip(await findRow('Spare switch'))).toBe('Missing');
  const list = screen.getByRole('list', { name: 'Assets' });
  expect(within(list).queryByText('DPI')).toBeNull();
});

it('the printer line names the saved printer', async () => {
  render_();
  expect(await screen.findByText('Printer: ZD421 · 203 DPI')).toBeTruthy();
  const link = screen.getByRole('link', { name: 'Printer Setup' });
  expect(link.getAttribute('href')).toBe('/labels/printers');
});

it('a web kiosk with no saved printer says so', async () => {
  station.state = 'no_settings';
  render_();
  expect(await screen.findByText(byFullText('No printer is set up on this kiosk. Set one up in Printer Setup.'))).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Printer Setup' }).getAttribute('href')).toBe('/labels/printers');
  await findRow('Rack A01 server');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Rack A01 server' }));
  const print = screen.getByRole('button', { name: /^Print \d+ labels?$/ }) as HTMLButtonElement;
  expect(print.disabled).toBe(true);
});

it("a laptop that isn't a Label Station says so", async () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  station.state = 'no_settings';
  render_();
  expect(await screen.findByText(byFullText(
    "This laptop isn't set up to print labels. Make it a Label Station in Kiosk Setup to print here."))).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Kiosk Setup' }).getAttribute('href')).toBe('/setup');
});

it.each([
  ['network', new ApiError(0, 'network')],
  ['edge_offline', new ApiError(0, 'network')],
  ['cloud_sign_in_required', new ApiError(403, 'cloud_sign_in_required')],
])('offline on %s serves the cached bundle and vocab', async (_, err) => {
  await putCachedBundle(bundle('top', [label('a-1')]), new Date(Date.now() - 2 * 60 * 60_000));
  await writeMeta('label_vocab', { rows: VOCAB, cached_at: new Date().toISOString() });
  api.fetchLabelVocab.mockRejectedValue(err);
  api.fetchKioskLabelBundle.mockRejectedValue(err);
  render_();
  const notice = await screen.findByText(/^Offline — using labels downloaded/);
  expect(notice.textContent).toBe(
    'Offline — using labels downloaded 2h ago. Printing works; changes made elsewhere are not reflected.');
  await waitFor(async () => expect(labelChip(await findRow('Rack A01 server'))).toBe('Ready'));
  expect(typeCardTitles()).toContain('Top Label');
});

it("offline with no vocab uses the cached bundles' types", async () => {
  await putCachedBundle(bundle('front', [label('a-2')]));
  api.fetchLabelVocab.mockRejectedValue(new ApiError(0, 'network'));
  api.fetchKioskLabelBundle.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await waitFor(() => expect(typeCardTitles()).toContain('front'));
  await waitFor(async () => expect(labelChip(await findRow('Spare switch'))).toBe('Ready'));
});

it('a failed load with no cache offers Retry', async () => {
  api.fetchKioskLabelBundle.mockRejectedValue(new ApiError(500, 'server_error'));
  render_();
  expect(await screen.findByText("Couldn't load Top Label labels.")).toBeTruthy();
  expect(api.fetchKioskLabelBundle).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.fetchKioskLabelBundle).toHaveBeenCalledTimes(2));
});

it("rows from another move's sync are not listed", async () => {
  await seedMove('i-1', 'i-0');
  render_();
  expect(await screen.findByText('No move data on this kiosk. Sync it from Kiosk Setup.')).toBeTruthy();
  expect(queryRow('Rack A01 server')).toBeNull();
});

it('a late bundle for the previous type is dropped', async () => {
  const top = deferred<ReturnType<typeof bundle>>();
  api.fetchKioskLabelBundle.mockImplementation(async (id: string, type: string) => (
    type === 'top' ? top.promise : bundle(type, [label('a-2')], id)));
  render_();
  await waitFor(() => expect(api.fetchKioskLabelBundle).toHaveBeenCalledWith('i-1', 'top'));
  await userEvent.click(typeCard('Front Label'));
  await waitFor(async () => expect(labelChip(await findRow('Spare switch'))).toBe('Ready'));
  await act(async () => { top.resolve(bundle('top', [label('a-1')])); await top.promise; });
  // let the dropped result's cache write and any state update settle
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(labelChip(await findRow('Rack A01 server'))).toBe('Missing');
  expect(labelChip(await findRow('Spare switch'))).toBe('Ready');
});

it('a container type lists containers and seeds 5 copies without saving them', async () => {
  render_();
  await waitFor(async () => expect(labelChip(await findRow('Rack A01 server'))).toBe('Ready'));
  await userEvent.click(typeCard('Container Label'));
  expect(await screen.findByText('Containers to print')).toBeTruthy();
  expect(await findRow('Crate 7')).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Print settings' }));
  expect((screen.getByLabelText('Copies') as HTMLInputElement).value).toBe('5');
  expect(readPrintSettings().copies).toBe(1);
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));

  await userEvent.click(typeCard('Top Label'));
  await userEvent.click(screen.getByRole('button', { name: 'Print settings' }));
  expect((screen.getByLabelText('Copies') as HTMLInputElement).value).toBe('1');
});

it('the move changing clears the selection', async () => {
  render_();
  await findRow('Rack A01 server');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Rack A01 server' }));
  expect((screen.getByRole('checkbox', { name: 'Select Rack A01 server' }) as HTMLInputElement).checked).toBe(true);
  await writeSyncedRows('i-2');
  act(() => { writeKioskSetup(setupFor('i-2')); });
  await waitFor(() => expect(api.fetchKioskLabelBundle).toHaveBeenCalledWith('i-2', 'top'));
  await findRow('Rack A01 server');
  const boxes = screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }) as HTMLInputElement[];
  expect(boxes.length).toBe(2);
  expect(boxes.some((b) => b.checked)).toBe(false);
});
