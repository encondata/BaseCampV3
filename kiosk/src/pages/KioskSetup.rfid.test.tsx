// @vitest-environment jsdom
/** Kiosk Setup's RFID Station path (laptop only): Station type → RFID type
 *  → Move → Select reader → Connect → Pair → Network check → Site → Scan
 *  type → Confirm & verify. A Dock Portal skips the scan type and always
 *  saves RFID 10 - Dock to Truck. */
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

import { ApiError } from '../lib/api';
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
    { key: 'rfid_1_cage_exit', label: 'RFID 1 - Cage Exit', color: '#123' },
    { key: 'rfid_10_dock_to_truck', label: 'RFID 10 - Dock to Truck (Auto Container Pack)', color: '#1890ff' },
    { key: 'received', label: 'Received', color: '#333' },
  ],
  sites: [],
};

const RESULT = {
  device_id: 'd-1', initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration (demo)',
  site_id: 's-2', site_name: 'NAP22 Hall', site_role: 'destination' as const,
  scan_status: 'rfid_1_cage_exit', scan_status_label: 'RFID 1 - Cage Exit',
};
const PORTAL_RESULT = {
  ...RESULT, scan_status: 'rfid_10_dock_to_truck',
  scan_status_label: 'RFID 10 - Dock to Truck (Auto Container Pack)',
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

/** RFID Station → the given RFID type → Move → reader → Connect → Pair →
 *  Network check, ending on Site. */
async function toSiteStep(user: ReturnType<typeof userEvent.setup>, type: 'Doorway' | 'Dock Portal') {
  await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
  await user.click(screen.getByRole('option', { name: new RegExp(type) }));
  await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
  await user.click(await screen.findByText('10.0.0.5'));
  await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  await screen.findByText('NAP22 Hall');
}

const SAVED = {
  initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
  siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination' as const,
  scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
  stationType: 'rfid' as const, reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
};
const SAVED_PORTAL = {
  ...SAVED, scanStatus: 'rfid_10_dock_to_truck',
  scanLabel: 'RFID 10 - Dock to Truck (Auto Container Pack)', rfidType: 'dock_portal' as const,
};

it('the RFID Station card names its new path', async () => {
  renderPage();
  const card = await screen.findByRole('option', { name: /RFID Station/ });
  expect(within(card).getByText(
    'Pairs a Zebra FX reader on this network. Next: RFID type → Move → Reader → Site.')).toBeTruthy();
});

it('step 2 asks for the RFID type; Truck Portal is shown but cannot be picked', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
  expect(screen.getByText('Step 2 of 10 · RFID type')).toBeTruthy();
  const titles = within(screen.getByRole('listbox', { name: 'RFID types' }))
    .getAllByRole('option').map((o) => o.querySelector('.setup-card-title')?.textContent);
  expect(titles).toEqual(['Doorway', 'Dock Portal', 'Truck Portal']);
  expect(screen.getByText(
    "Today's RFID station: the reader at a doorway. Next: Move → Reader → Site → Scan type.")).toBeTruthy();
  expect(screen.getByText(
    'Reads crates at the dock and sets them to RFID 10 - Dock to Truck. Next: Move → Reader → Site.'))
    .toBeTruthy();
  const truck = screen.getByRole('option', { name: /Truck Portal/ });
  expect(truck.getAttribute('aria-disabled')).toBe('true');
  await user.click(truck);
  expect(screen.getByText('Step 2 of 10 · RFID type')).toBeTruthy();
  expect(apiMock.startReaderScan).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Step 1 of 10 · Station type')).toBeTruthy();
});

it('a Doorway walks Move, then the reader, then Site and Scan type, out of 10', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
  await user.click(screen.getByRole('option', { name: /Doorway/ }));
  expect(await screen.findByText('Step 3 of 10 · Move')).toBeTruthy();
  expect(apiMock.startReaderScan).not.toHaveBeenCalled();
  await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
  expect(screen.getByText('Step 4 of 10 · Select reader')).toBeTruthy();
  await user.click(await screen.findByText('10.0.0.5'));
  expect(screen.getByText('Step 5 of 10 · Connect')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
  expect(screen.getByText('Step 6 of 10 · Pair')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Step 7 of 10 · Network check')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Step 8 of 10 · Site')).toBeTruthy();
  await user.click(cardFor('NAP22 Hall'));
  expect(screen.getByText('Step 9 of 10 · Scan type')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 1 - Cage Exit' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Received' })).toBeNull();
  await user.click(cardFor('RFID 1 - Cage Exit'));
  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2',
    scan_status: 'rfid_1_cage_exit', station_type: 'rfid', rfid_type: 'doorway',
  }));
  expect(await screen.findByText('Step 10 of 10 · Confirm & verify')).toBeTruthy();
  expect(readKioskSetup()).toMatchObject({ stationType: 'rfid', rfidType: 'doorway' });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Step 9 of 10 · Scan type')).toBeTruthy();
});

it('a Dock Portal skips the scan type and saves RFID 10 - Dock to Truck, out of 9', async () => {
  apiMock.submitKioskSetup.mockResolvedValue(PORTAL_RESULT);
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
  await user.click(screen.getByRole('option', { name: /Dock Portal/ }));
  expect(await screen.findByText('Step 3 of 9 · Move')).toBeTruthy();
  await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
  expect(screen.getByText('Step 4 of 9 · Select reader')).toBeTruthy();
  await user.click(await screen.findByText('10.0.0.5'));
  await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Step 7 of 9 · Network check')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Step 8 of 9 · Site')).toBeTruthy();
  await user.click(cardFor('NAP22 Hall'));
  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2',
    scan_status: 'rfid_10_dock_to_truck', station_type: 'rfid', rfid_type: 'dock_portal',
  }));
  expect(await screen.findByText('Step 9 of 9 · Confirm & verify')).toBeTruthy();
  expect(screen.queryByText('Which scan type?')).toBeNull();
  expect(readKioskSetup()).toMatchObject({
    stationType: 'rfid', rfidType: 'dock_portal', scanStatus: 'rfid_10_dock_to_truck',
    reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
  });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Step 8 of 9 · Site')).toBeTruthy();
});

it('a Dock Portal\'s Start Reader still opens /rfid_status', async () => {
  apiMock.submitKioskSetup.mockResolvedValue(PORTAL_RESULT);
  const user = userEvent.setup();
  renderPage();
  await toSiteStep(user, 'Dock Portal');
  await user.click(cardFor('NAP22 Hall'));
  const start = await screen.findByRole('button', { name: 'Start Reader' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  await user.click(start);
  expect(await screen.findByText('RFID status page')).toBeTruthy();
});

it('a Dock Portal never saves without RFID 10 - Dock to Truck in the scan types', async () => {
  apiMock.getSetupOptions.mockResolvedValue({
    ...OPTIONS, scan_types: OPTIONS.scan_types.filter((t) => t.key !== 'rfid_10_dock_to_truck'),
  });
  const user = userEvent.setup();
  renderPage();
  await toSiteStep(user, 'Dock Portal');
  await user.click(cardFor('NAP22 Hall'));
  expect(await screen.findByText(
    "RFID 10 - Dock to Truck isn't available as a scan type. Turn it on in the portal, then try again.",
  )).toBeTruthy();
  expect(apiMock.submitKioskSetup).not.toHaveBeenCalled();
  expect(screen.getByText('Step 8 of 9 · Site')).toBeTruthy();
  expect(readKioskSetup()).toBeNull();
});

it('a Dock Portal with no paired reader says so on the Site step', async () => {
  apiMock.submitKioskSetup.mockRejectedValue(new ApiError(422, 'reader_required'));
  const user = userEvent.setup();
  renderPage();
  await toSiteStep(user, 'Dock Portal');
  await user.click(cardFor('NAP22 Hall'));
  expect(await screen.findByText('Pair a reader first')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Back to the reader step' }));
  expect(screen.getByText('Step 4 of 9 · Select reader')).toBeTruthy();
});

it('the summary of a Dock Portal names its RFID type and scan type; Change setup preselects it', async () => {
  writeKioskSetup(SAVED_PORTAL);
  writeSetupState('complete');
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('RFID · Laptop')).toBeTruthy();
  const summary = document.querySelector('.setup-summary') as HTMLElement;
  expect(within(summary).getByText('Dock Portal')).toBeTruthy();
  expect(summary.textContent).toContain('Scan type: RFID 10 - Dock to Truck (Auto Container Pack)');
  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 9 · Station type')).toBeTruthy();
  await user.click(cardFor('RFID Station'));
  expect(screen.getByText('Step 2 of 9 · RFID type')).toBeTruthy();
  expect(cardFor('Dock Portal').getAttribute('aria-selected')).toBe('true');
  expect(cardFor('Doorway').getAttribute('aria-selected')).toBe('false');
});

it('a Dock Portal summary falls back to the built-in label when none was saved', async () => {
  writeKioskSetup({ ...SAVED_PORTAL, scanLabel: '' });
  writeSetupState('complete');
  renderPage();
  await screen.findByText('RFID · Laptop');
  expect(document.querySelector('.setup-summary')?.textContent)
    .toContain('Scan type: RFID 10 - Dock to Truck (Auto Container Pack)');
});

it('an RFID Station saved before RFID types reads as a Doorway', async () => {
  writeKioskSetup(SAVED);
  writeSetupState('complete');
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('RFID · Laptop')).toBeTruthy();
  const summary = document.querySelector('.setup-summary') as HTMLElement;
  expect(within(summary).getByText('Doorway')).toBeTruthy();
  expect(summary.textContent).toContain('scan type RFID 1 - Cage Exit');
  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 10 · Station type')).toBeTruthy();
  await user.click(cardFor('RFID Station'));
  expect(cardFor('Doorway').getAttribute('aria-selected')).toBe('true');
});

it('switching a Doorway to a Dock Portal in Change setup drops the scan step', async () => {
  writeKioskSetup({ ...SAVED, rfidType: 'doorway' });
  writeSetupState('complete');
  apiMock.submitKioskSetup.mockResolvedValue(PORTAL_RESULT);
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Change setup' }));
  await toSiteStep(user, 'Dock Portal');
  expect(screen.getByText('Step 8 of 9 · Site')).toBeTruthy();
  await user.click(cardFor('NAP22 Hall'));
  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith(
    expect.objectContaining({ scan_status: 'rfid_10_dock_to_truck', rfid_type: 'dock_portal' })));
});
