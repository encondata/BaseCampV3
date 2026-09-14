// @vitest-environment jsdom
/** The Scanning page against a real (fake) IndexedDB and a stubbed
 *  ingest endpoint: focus, matching, the flash, and the scan list. */
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postScans: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, postScans: api.postScans };
});

import { clearFlash, readFlash } from '../lib/flash';
import { closeDb, replaceAll } from '../lib/localDb';
import { writeKioskSetup } from '../lib/kioskSetup';
import { resetOutboxForTest, stopSender } from '../lib/outbox';
import Scan from './Scan';

const ASSETS = [
  {
    id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: '000000000000100348',
    serial_number: 'SN-4242', make: 'Cisco', model: 'Nexus 9000',
    make_model: 'Cisco Nexus 9000', label: {},
  },
  {
    id: 'a-2', asset_id: '10043', name: 'Patch panel', rfid: null,
    serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '', label: {},
  },
];

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'Acme DC Move',
  siteId: 'site-1', siteName: 'Cage 12', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

beforeEach(async () => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetOutboxForTest();
  clearFlash();
  localStorage.clear();
  writeKioskSetup(SETUP);
  api.postScans.mockReset();
  // Nothing is accepted by default, so a row's color in these tests is
  // the one the page gave it, not one the network changed underneath.
  api.postScans.mockResolvedValue({ accepted: [], rejected: [] });
});

afterEach(() => {
  cleanup();
  stopSender();
  clearFlash();
});

async function renderScan(assets: unknown[] = ASSETS) {
  await replaceAll('assets', assets);
  render(<MemoryRouter><Scan /></MemoryRouter>);
  await waitFor(() =>
    expect((screen.getByLabelText('Scan value') as HTMLInputElement).disabled).toBe(false));
  return screen.getByLabelText('Scan value') as HTMLInputElement;
}

it('shows the setup\'s scan label and move · site, and focuses the input on mount', async () => {
  const input = await renderScan();
  expect(screen.getByRole('heading', { name: 'RFID 1 - Cage Exit' })).toBeTruthy();
  expect(screen.getByText('Acme DC Move · Cage 12')).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

it('a matched RFID flashes the good color, queues the scan, and lists the asset', async () => {
  const input = await renderScan();
  await userEvent.type(input, '100348{Enter}');

  expect(readFlash()?.color).toBe('hsl(150 60% 45%)');
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);      // refocused after submit

  const row = await screen.findByRole('row', { name: /Rack 4 switch/ });
  const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
  expect(cells.slice(0, 4)).toEqual(['SN-4242', 'Rack 4 switch', '100348', 'Cisco Nexus 9000']);
  expect(within(row).getByText('Queued')).toBeTruthy();
  expect(row.className).toContain('is-queued');
  // The raw EPC stays one hover away, exactly as in the portal lists.
  expect(within(row).getAllByRole('cell')[2].getAttribute('title')).toBe('000000000000100348');
});

it('matches a serial and a padded EPC the same way, and sends what the setup chose', async () => {
  const input = await renderScan();
  await userEvent.type(input, 'sn-4242{Enter}');
  await screen.findByRole('row', { name: /Rack 4 switch/ });

  await waitFor(() => expect(api.postScans).toHaveBeenCalled());
  const body = api.postScans.mock.calls[0][0];
  expect(body.scans[0]).toMatchObject({
    scanned_value: 'sn-4242', scan_type: 'barcode', asset_id: 'a-1',
    site_id: 'site-1', initiative_id: 'init-1', scan_status: 'cage_exit',
  });
});

it('an unknown value flashes the not-found color and lists it as No match', async () => {
  const input = await renderScan();
  await userEvent.type(input, 'nope123{Enter}');

  expect(readFlash()?.color).toBe('hsl(0 70% 50%)');
  const row = await screen.findByRole('row', { name: /nope123/ });
  const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
  expect(cells.slice(0, 4)).toEqual(['nope123', '—', '—', '—']);
  expect(within(row).getByText('No match')).toBeTruthy();
  expect(row.className).toContain('is-nomatch');
});

it('uses the colors the Appearance tab saved', async () => {
  localStorage.setItem('ss.kiosk.appearance', JSON.stringify({
    good_scan: { h: 280, s: 90, l: 40 }, not_found_scan: { h: 30, s: 90, l: 40 },
  }));
  const input = await renderScan();
  await userEvent.type(input, '100348{Enter}');
  expect(readFlash()?.color).toBe('hsl(280 90% 40%)');
});

it('an empty Enter does nothing at all', async () => {
  const input = await renderScan();
  await userEvent.type(input, '   {Enter}');
  expect(readFlash()).toBeNull();
  expect(screen.getByText('Nothing scanned yet.')).toBeTruthy();
});

it('lists the newest scan first', async () => {
  const input = await renderScan();
  await userEvent.type(input, '10043{Enter}');
  await screen.findByRole('row', { name: /Patch panel/ });
  await userEvent.type(input, '100348{Enter}');
  await screen.findByRole('row', { name: /Rack 4 switch/ });

  const names = screen.getAllByRole('row').slice(1).map((r) =>
    within(r).getAllByRole('cell')[1].textContent);
  expect(names).toEqual(['Rack 4 switch', 'Patch panel']);
});

it('counts the queue and offers Clear sent once something has settled', async () => {
  const input = await renderScan();
  await userEvent.type(input, 'nope123{Enter}');
  await screen.findByRole('row', { name: /nope123/ });

  expect(screen.getByText(/0 queued · 0 sent · 0 failed/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Clear sent' }));
  await waitFor(() => expect(screen.getByText('Nothing scanned yet.')).toBeTruthy());
});

it('an empty local database disables the input and says where to fix it', async () => {
  render(<MemoryRouter><Scan /></MemoryRouter>);
  expect(await screen.findByText('No move data on this kiosk. Sync it from Kiosk Setup.'))
    .toBeTruthy();
  expect((screen.getByLabelText('Scan value') as HTMLInputElement).disabled).toBe(true);
});

it('takes focus back when it drifts to something that does not want it', async () => {
  const input = await renderScan();
  const stray = document.createElement('div');
  stray.tabIndex = -1;
  document.body.appendChild(stray);

  stray.focus();
  expect(document.activeElement).toBe(stray);
  await waitFor(() => expect(document.activeElement).toBe(input));
  stray.remove();
});

it('leaves focus alone when the operator clicks a button on the page', async () => {
  const input = await renderScan();
  await userEvent.type(input, 'nope123{Enter}');
  await screen.findByRole('row', { name: /nope123/ });

  const clear = screen.getByRole('button', { name: 'Clear sent' });
  clear.focus();
  await new Promise((r) => setTimeout(r, 10));
  expect(document.activeElement).toBe(clear);
});
