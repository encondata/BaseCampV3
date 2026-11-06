// @vitest-environment jsdom
/** Kiosk Setup's Dock path (laptop only): the RFID Station's path — Select
 *  reader → Connect → Pair → Network check → Move → Site → Scan type →
 *  Confirm & verify — with only RFID scan types, ending on the Dock screen. */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed', person: { display_name: 'Alex Worker' }, perms: null, preferences: null,
  mustChangePassword: false, sessionExpiresAt: '2030-01-01T00:00:00Z', registration: 'ok',
  heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
  kioskMove: null as null | { initiative_id: string; name: string },
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const apiMock = vi.hoisted(() => ({
  getSetupOptions: vi.fn(),
  submitKioskSetup: vi.fn(),
  startReaderScan: vi.fn(),
  getReaderScan: vi.fn(),
  connectReader: vi.fn(),
  pairReader: vi.fn(),
  runCheck: vi.fn(),
  startReader: vi.fn(),
  getLabelStation: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

const syncMock = vi.hoisted(() => ({ runSync: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, runSync: syncMock.runSync, useSyncStatus: () => ({ phase: 'idle' }) };
});

import { readKioskSetup, writeKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';
import KioskSetup from './KioskSetup';

const OPTIONS = {
  initiatives: [
    {
      id: 'i-1', name: 'NAP11 Hall Migration (demo)', status: 'planned',
      status_label: 'Planned', client_name: 'Acme Corp',
      scheduled_start: null, scheduled_end: null,
      source_site: { id: 's-1', name: 'NAP11 Hall' },
      destination_site: { id: 's-2', name: 'NAP22 Hall' },
    },
  ],
  scan_types: [
    { key: 'rfid_2_dock', label: 'RFID 2 - Dock', color: '#456' },
    { key: 'received', label: 'Received', color: '#333' },
  ],
  sites: [],
};

const RESULT = {
  device_id: 'd-1', initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration (demo)',
  site_id: 's-2', site_name: 'NAP22 Hall', site_role: 'destination' as const,
  scan_status: 'rfid_2_dock', scan_status_label: 'RFID 2 - Dock',
};

const VERSIONS = { readerApplication: '3.10.30', radioFirmware: '2.1.1', cloudAgentApplication: '3.0.12' };
const CONNECTED = {
  ip: '10.0.0.5', model: 'FX9600', serial: '1234ABCD', versions: VERSIONS,
  status: {
    uptime: '26 days 01:11:17', radioConnection: 'connected',
    antennas: { 1: 'connected', 2: 'connected', 3: 'disconnected', 4: 'disconnected' },
  },
  paired_with: null,
};
const PAIRED = {
  paired: true,
  reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600', versions: VERSIONS,
            paired_at: '2026-11-05T14:00:00Z' },
  endpoint_url: 'http://10.0.0.9:8091/rfid/1234ABCD/…',
};

beforeEach(() => {
  localStorage.clear();
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  apiMock.getSetupOptions.mockReset().mockResolvedValue(OPTIONS);
  apiMock.submitKioskSetup.mockReset().mockResolvedValue(RESULT);
  apiMock.getLabelStation.mockReset().mockResolvedValue(null);
  apiMock.startReaderScan.mockReset().mockResolvedValue({ scan_id: 'sc1' });
  apiMock.getReaderScan.mockReset().mockResolvedValue({
    scan_id: 'sc1', state: 'done', probed: 254, total: 254,
    readers: [{ ip: '10.0.0.5', model: 'FX9600', serial: '1234ABCD', paired_with: null }],
    host: { ips: ['10.0.0.9'], fresh: true },
  });
  apiMock.connectReader.mockReset().mockResolvedValue(CONNECTED);
  apiMock.pairReader.mockReset().mockResolvedValue(PAIRED);
  apiMock.runCheck.mockReset().mockImplementation((name: string) => Promise.resolve(
    { name, ok: true, state: 'ok', detail: '' }));
  apiMock.startReader.mockReset().mockResolvedValue({ reading: true });
  syncMock.runSync.mockClear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<KioskSetup />} />
        <Route path="/" element={<div>Home</div>} />
        <Route path="/rfid_status" element={<div>RFID status page</div>} />
        <Route path="/dock" element={<div>Dock page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function cardFor(title: string): HTMLElement {
  const button = screen.getByText(title).closest('button');
  if (!button) throw new Error(`no card button found for "${title}"`);
  return button;
}

/** Dock Station → reader → Connect → Pair → Network check → Move → Site. */
async function toScanStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('option', { name: /Dock Station/ }));
  await user.click(await screen.findByText('10.0.0.5'));
  await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
  await user.click(cardFor('NAP22 Hall'));
}

it('step 1 offers a fourth card, Dock Station, with its next steps', async () => {
  renderPage();
  const card = await screen.findByRole('option', { name: /Dock Station/ });
  expect(within(card).getByText('Dock Station')).toBeTruthy();
  expect(within(card).getByText(
    'Packs crates read at an RFID curtain. Next: Select reader → Connect → Pair, then the move.',
  )).toBeTruthy();
  const titles = within(screen.getByRole('listbox', { name: 'Station types' }))
    .getAllByRole('option').map((o) => o.querySelector('.setup-card-title')?.textContent);
  expect(titles).toEqual(['Label Station', 'RFID Station', 'Time Clock', 'Dock Station']);
});

it('the Dock path walks Select reader first, counted out of 9 like the RFID path', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('option', { name: /Dock Station/ }));
  expect(screen.getByText('Step 2 of 9 · Select reader')).toBeTruthy();
  expect(await screen.findByText('10.0.0.5')).toBeTruthy();
  expect(apiMock.startReaderScan).toHaveBeenCalledTimes(1);
  await user.click(cardFor('10.0.0.5'));
  expect(screen.getByText('Step 3 of 9 · Connect')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
  expect(screen.getByText('Step 4 of 9 · Pair')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Step 5 of 9 · Network check')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Step 6 of 9 · Move')).toBeTruthy();
});

it('offers only scan types with RFID in the name', async () => {
  const user = userEvent.setup();
  renderPage();
  await toScanStep(user);
  expect(screen.getByText('Step 8 of 9 · Scan type')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 2 - Dock' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Received' })).toBeNull();
});

it('says so when no scan type mentions RFID', async () => {
  apiMock.getSetupOptions.mockResolvedValue({
    ...OPTIONS, scan_types: [{ key: 'received', label: 'Received', color: '#333' }],
  });
  const user = userEvent.setup();
  renderPage();
  await toScanStep(user);
  expect(screen.getByText(
    "No RFID scan types are set up. Add an active status value with RFID in its name on the portal's Variables page.",
  )).toBeTruthy();
});

it('saves a Dock with its paired reader, and Confirm\'s Start Reader lands on /dock', async () => {
  const user = userEvent.setup();
  renderPage();
  await toScanStep(user);
  await user.click(cardFor('RFID 2 - Dock'));
  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2',
    scan_status: 'rfid_2_dock', station_type: 'dock',
  }));
  expect(await screen.findByText('Step 9 of 9 · Confirm & verify')).toBeTruthy();
  expect(readKioskSetup()).toMatchObject({
    stationType: 'dock', reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
  });
  const start = await screen.findByRole('button', { name: 'Start Reader' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  await user.click(start);
  expect(apiMock.startReader).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Dock page')).toBeTruthy();
  expect(screen.queryByText('RFID status page')).toBeNull();
});

it('the summary of a saved Dock names it and its reader', async () => {
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
    scanStatus: 'rfid_2_dock', scanLabel: 'RFID 2 - Dock',
    stationType: 'dock', reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
  });
  writeSetupState('complete');
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('Dock · Laptop')).toBeTruthy();
  expect(screen.getByText('FX9600 1234ABCD at 10.0.0.5')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 9 · Station type')).toBeTruthy();
  expect(cardFor('Dock Station').getAttribute('aria-selected')).toBe('true');
});
