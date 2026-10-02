// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed', person: { display_name: 'Alex Worker' }, perms: null, preferences: null,
  mustChangePassword: false, sessionExpiresAt: '2030-01-01T00:00:00Z', registration: 'ok',
  heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const apiMock = vi.hoisted(() => ({
  getSetupOptions: vi.fn(),
  submitKioskSetup: vi.fn(),
  startReaderScan: vi.fn(),
  getReaderScan: vi.fn(),
  connectReader: vi.fn(),
  pairReader: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

const syncMock = vi.hoisted(() => ({
  runSync: vi.fn(() => Promise.resolve()),
  status: { phase: 'idle' } as { phase: string; assets?: number; people?: number; containers?: number; trucks?: number; syncedAt?: string; error?: string },
}));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, runSync: syncMock.runSync, useSyncStatus: () => syncMock.status };
});

import { ApiError } from '../lib/api';
import { getIdentity } from '../lib/identity';
import { readKioskSetup, writeKioskSetup } from '../lib/kioskSetup';
import { readSetupState, writeSetupState } from '../lib/setupState';
import KioskSetup from './KioskSetup';

const OPTIONS = {
  initiatives: [
    {
      id: 'i-1', name: 'NAP11 Hall Migration (demo)', status: 'planned',
      status_label: 'Planned', client_name: 'Acme Corp',
      scheduled_start: '2026-09-20T00:00:00+00:00', scheduled_end: null,
      source_site: { id: 's-1', name: 'NAP11 Hall' },
      destination_site: { id: 's-2', name: 'NAP22 Hall' },
    },
    {
      id: 'i-2', name: 'NAP7 Rack Move', status: 'in_progress',
      status_label: 'In progress', client_name: null,
      scheduled_start: null, scheduled_end: null,
      source_site: null, destination_site: { id: 's-3', name: 'NAP7 Hall' },
    },
    {
      id: 'i-3', name: 'No Sites Move', status: 'planned',
      status_label: 'Planned', client_name: null,
      scheduled_start: null, scheduled_end: null,
      source_site: null, destination_site: null,
    },
  ],
  scan_types: [
    { key: 'rfid_1_cage_exit', label: 'RFID 1 - Cage Exit', color: '#123' },
    { key: 'rfid_2_dock', label: 'RFID 2 - Dock', color: '#456' },
  ],
};

const RESULT = {
  device_id: 'd-1', initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration (demo)',
  site_id: 's-2', site_name: 'NAP22 Hall', site_role: 'destination' as const,
  scan_status: 'rfid_1_cage_exit', scan_status_label: 'RFID 1 - Cage Exit',
};

beforeEach(() => {
  localStorage.clear();
  apiMock.getSetupOptions.mockReset().mockResolvedValue(OPTIONS);
  apiMock.submitKioskSetup.mockReset().mockResolvedValue(RESULT);
  syncMock.runSync.mockClear();
  syncMock.status = { phase: 'idle' };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<KioskSetup />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function cardFor(title: string): HTMLElement {
  const titleEl = screen.getByText(title);
  const button = titleEl.closest('button');
  if (!button) throw new Error(`no card button found for "${title}"`);
  return button;
}

async function goToSiteStep(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('NAP11 Hall Migration (demo)');
  await user.click(cardFor('NAP11 Hall Migration (demo)'));
}

async function goToScanStep(user: ReturnType<typeof userEvent.setup>) {
  await goToSiteStep(user);
  await user.click(cardFor('NAP22 Hall'));
}

it('loads options and renders each move as a card with name, status chip, client, and sites', async () => {
  const { container } = renderPage();
  expect(screen.getByText('Loading moves…')).toBeTruthy();

  await screen.findByText('NAP11 Hall Migration (demo)');
  const napCard = cardFor('NAP11 Hall Migration (demo)');
  expect(screen.getByRole('option', { name: /NAP11 Hall Migration \(demo\)/ })).toBeTruthy();
  expect(within(napCard).getByText('Planned')).toBeTruthy();
  expect(within(napCard).getByText('Acme Corp')).toBeTruthy();
  expect(within(napCard).getByText('NAP11 Hall → NAP22 Hall')).toBeTruthy();

  const rackCard = cardFor('NAP7 Rack Move');
  expect(within(rackCard).getByText('In progress')).toBeTruthy();
  expect(within(rackCard).getByText('— → NAP7 Hall')).toBeTruthy();
  expect(rackCard.querySelector('.chip.c-green')).toBeTruthy();

  // no native <select> anywhere in the wizard
  expect(container.querySelector('select')).toBeNull();
});

it('renders a move\'s scheduled_start without shifting it west of UTC', async () => {
  // scheduled_start is a date-only field (midnight UTC for a plain
  // YYYY-MM-DD input), the kiosk API serves it exactly like the portal's
  // scheduled_start (see api/routes/kiosk.py). vitest inherits whatever
  // TZ the shell has, so pin a west-of-UTC zone here — on a UTC host a
  // bare `new Date(iso)` bug and the parseApiDay-style fix would agree,
  // proving nothing.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Denver';
  try {
    renderPage();
    const napCard = await screen.findByText('NAP11 Hall Migration (demo)');
    expect(within(napCard.closest('button')!).getByText('Starts Sep 20')).toBeTruthy();
    expect(within(napCard.closest('button')!).queryByText('Starts Sep 19')).toBeNull();
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

it('clicking a move advances to the site step, listing the move\'s sites with roles', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('NAP11 Hall Migration (demo)');
  await user.click(cardFor('NAP11 Hall Migration (demo)'));

  expect(screen.getByText('Step 2 of 3 · Site')).toBeTruthy();
  expect(screen.getByText('Which site is this kiosk at?')).toBeTruthy();
  expect(screen.getByRole('option', { name: /SOURCE/ })).toBeTruthy();
  expect(screen.getByRole('option', { name: /DESTINATION/ })).toBeTruthy();
  expect(screen.getByText('NAP11 Hall')).toBeTruthy();
  expect(screen.getByText('NAP22 Hall')).toBeTruthy();
});

it('a move with only a destination site skips the null source option', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('NAP7 Rack Move');
  await user.click(cardFor('NAP7 Rack Move'));

  expect(screen.getByText('NAP7 Hall')).toBeTruthy();
  expect(screen.queryByRole('option', { name: /SOURCE/ })).toBeNull();
});

it('a move with no sites shows the copy and no site cards', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('No Sites Move');
  await user.click(cardFor('No Sites Move'));

  expect(screen.getByText('This move has no sites yet. Ask a coordinator to add them.')).toBeTruthy();
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
});

it('clicking a site advances to the scan-type step', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToSiteStep(user);
  await user.click(cardFor('NAP22 Hall'));

  expect(screen.getByText('Step 3 of 3 · Scan type')).toBeTruthy();
  expect(screen.getByText('Which scan type?')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 1 - Cage Exit' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 2 - Dock' })).toBeTruthy();
});

it('clicking a scan type saves the setup and shows the summary', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));

  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: getIdentity().serial, initiative_id: 'i-1', site_id: 's-2',
    scan_status: 'rfid_1_cage_exit',
  }));

  expect(await screen.findByText(/This kiosk is set up for/)).toBeTruthy();
  expect(screen.getByText('NAP11 Hall Migration (demo)')).toBeTruthy();
  expect(screen.getByText('NAP22 Hall')).toBeTruthy();
  expect(screen.getByText('RFID 1 - Cage Exit')).toBeTruthy();
  expect(readKioskSetup()).toEqual({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
    scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
  });
  expect(readSetupState()).toBe('complete');
});

it('a laptop sign-in made offline is told to sign in again while online', async () => {
  apiMock.submitKioskSetup.mockRejectedValue(new ApiError(403, 'cloud_sign_in_required'));
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));

  expect(await screen.findByText('Sign in again while online to do this.')).toBeTruthy();
  expect(readSetupState()).toBe('failed');
});

it('a rejected submit shows the inline error, sets failed, and re-enables the cards', async () => {
  apiMock.submitKioskSetup.mockRejectedValue(new ApiError(500, 'server_error'));
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));

  expect(await screen.findByText("Couldn't save the kiosk setup (server_error). Try again.")).toBeTruthy();
  expect(readSetupState()).toBe('failed');
  const card = cardFor('RFID 1 - Cage Exit') as HTMLButtonElement;
  expect(card.disabled).toBe(false);
});

it('shows empty-moves copy when there are no moves to offer', async () => {
  apiMock.getSetupOptions.mockResolvedValue({ initiatives: [], scan_types: OPTIONS.scan_types });
  renderPage();
  expect(await screen.findByText('No active moves. Ask a coordinator to plan one.')).toBeTruthy();
  expect(screen.queryAllByRole('option')).toHaveLength(0);
});

it('a load failure shows an error with Retry', async () => {
  apiMock.getSetupOptions.mockRejectedValueOnce(new ApiError(500, 'server_error'));
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText("Couldn't load setup options.")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('NAP7 Rack Move')).toBeTruthy();
});

it('changing the move on step 1 clears the previously chosen site', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToSiteStep(user);
  await user.click(cardFor('NAP22 Hall'));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(cardFor('NAP7 Rack Move'));

  expect(cardFor('NAP7 Hall').getAttribute('aria-selected')).toBe('false');
});

it('Back from the site step returns to the move list with the chosen move aria-selected', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToSiteStep(user);
  await user.click(screen.getByRole('button', { name: 'Back' }));

  expect(screen.getByText('Step 1 of 3 · Move')).toBeTruthy();
  const move = cardFor('NAP11 Hall Migration (demo)');
  expect(move.getAttribute('aria-selected')).toBe('true');
});

it('Change setup re-enters the wizard at step 1, pre-selected all the way through', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));
  await screen.findByText(/This kiosk is set up for/);

  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 3 · Move')).toBeTruthy();
  await waitFor(() => expect(cardFor('NAP11 Hall Migration (demo)').getAttribute('aria-selected'))
    .toBe('true'));

  await user.click(cardFor('NAP11 Hall Migration (demo)'));
  expect(cardFor('NAP22 Hall').getAttribute('aria-selected')).toBe('true');

  await user.click(cardFor('NAP22 Hall'));
  expect(cardFor('RFID 1 - Cage Exit').getAttribute('aria-selected')).toBe('true');
});

it('"Go to home" navigates to /', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));
  await screen.findByText(/This kiosk is set up for/);
  await user.click(screen.getByRole('button', { name: 'Go to home' }));
  expect(await screen.findByText('Home')).toBeTruthy();
});

it('a rejected re-save of an already-complete setup keeps it complete, and Cancel returns to the summary', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));
  await screen.findByText(/This kiosk is set up for/);
  expect(readSetupState()).toBe('complete');

  apiMock.submitKioskSetup.mockRejectedValueOnce(new ApiError(500, 'server_error'));
  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));

  expect(await screen.findByText("Couldn't save the kiosk setup (server_error). Try again."))
    .toBeTruthy();
  // the transient failure must not downgrade a kiosk that was already
  // working — the state stays 'complete', not 'failed'
  expect(readSetupState()).toBe('complete');

  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByText(/This kiosk is set up for/)).toBeTruthy();
});

it('a cached move no longer in the loaded options is cleared and step 2 is not entered', async () => {
  localStorage.setItem('ss.kiosk.setupState', 'complete');
  localStorage.setItem('ss.kiosk.setup', JSON.stringify({
    initiativeId: 'stale-move', initiativeName: 'Stale Move',
    siteId: 'stale-site', siteName: 'Stale Site', siteRole: 'source',
    scanStatus: 'stale-scan', scanLabel: 'Stale Scan',
  }));
  const user = userEvent.setup();
  renderPage();
  await screen.findByText(/This kiosk is set up for/);
  await user.click(screen.getByRole('button', { name: 'Change setup' }));

  await screen.findByText('NAP11 Hall Migration (demo)');
  await waitFor(() => {
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
  });
  expect(screen.getByText('Step 1 of 3 · Move')).toBeTruthy();
});


// ── local move data (sync) ──────────────────────────────────────────

it('a successful save kicks off the move-data download', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));

  await screen.findByText(/This kiosk is set up for/);
  expect(syncMock.runSync).toHaveBeenCalledWith('i-1', 'NAP11 Hall Migration (demo)');
});

function renderSummaryWith(status: typeof syncMock.status) {
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
    scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
  });
  writeSetupState('complete');
  syncMock.status = status;
  return renderPage();
}

it('the summary shows the running, done, and error sync states', async () => {
  const { container } = renderSummaryWith({ phase: 'running' });
  expect(await screen.findByText('Downloading move data…')).toBeTruthy();
  expect(container.querySelector('.sync-status')).toBeTruthy();
  cleanup();

  renderSummaryWith({
    phase: 'done', assets: 15, people: 4, containers: 6, trucks: 2, syncedAt: '2026-09-13T18:14:00Z',
  });
  expect(await screen.findByText(/Local data: 15 assets · 4 people · 6 containers · 2 trucks · synced /)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sync again' })).toBeTruthy();
  cleanup();

  renderSummaryWith({ phase: 'error', error: 'network' });
  expect(await screen.findByText("Couldn't download move data (network).")).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('"Sync again" re-runs the download for the saved move', async () => {
  const user = userEvent.setup();
  renderSummaryWith({ phase: 'done', assets: 15, people: 4, containers: 6, trucks: 2, syncedAt: '2026-09-13T18:14:00Z' });
  await user.click(await screen.findByRole('button', { name: 'Sync again' }));
  expect(syncMock.runSync).toHaveBeenCalledWith('i-1', 'NAP11 Hall Migration (demo)');
});

it('an idle summary offers "Sync now" (e.g. after Clear local data)', async () => {
  const user = userEvent.setup();
  renderSummaryWith({ phase: 'idle' });
  expect(await screen.findByText('No move data on this kiosk yet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Sync now' }));
  expect(syncMock.runSync).toHaveBeenCalledWith('i-1', 'NAP11 Hall Migration (demo)');
});


// ── laptop: station type and the RFID reader steps ─────────────────

const READERS = [
  { ip: '10.0.0.5', model: 'FX9600', serial: '1234ABCD', paired_with: null },
  { ip: '10.0.0.6', model: 'FX9600', serial: '9999ZZZZ', paired_with: 'ServerSherpa Kiosk ABCD (Front desk)' },
];
const SCAN_DONE = {
  scan_id: 'sc1', state: 'done', probed: 254, total: 254, readers: READERS,
  host: { ips: ['10.0.0.9'], fresh: true },
};
const CONNECTED = {
  ip: '10.0.0.5', model: 'FX9600', serial: '1234ABCD',
  versions: { readerApplication: '3.10.30', radioFirmware: '2.1.1', cloudAgentApplication: '3.0.12' },
  status: {
    uptime: '26 days 01:11:17', radioConnection: 'connected',
    antennas: { 1: 'connected', 2: 'connected', 3: 'disconnected', 4: 'disconnected' },
  },
  paired_with: null,
};
const PAIRED = {
  paired: true,
  reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600', versions: CONNECTED.versions,
            paired_at: '2026-10-01T18:00:00Z' },
  endpoint_url: 'http://10.0.0.9:8091/rfid/1234ABCD/…',
};

describe('laptop mode', () => {
  beforeEach(() => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
    apiMock.startReaderScan.mockReset().mockResolvedValue({ scan_id: 'sc1' });
    apiMock.getReaderScan.mockReset().mockResolvedValue(SCAN_DONE);
    apiMock.connectReader.mockReset().mockResolvedValue(CONNECTED);
    apiMock.pairReader.mockReset().mockResolvedValue(PAIRED);
  });
  afterEach(() => { delete window.__KIOSK_CONFIG__; });

  async function toReaderStep(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    await screen.findByText('10.0.0.5');
  }

  async function toConnectStep(user: ReturnType<typeof userEvent.setup>) {
    await toReaderStep(user);
    await user.click(cardFor('10.0.0.5'));
    await screen.findByText('1234ABCD');
  }

  it('step 1 asks what the station is and offers both cards', async () => {
    renderPage();
    expect(await screen.findByText('What is this station?')).toBeTruthy();
    expect(screen.getByText('Step 1 · Station type')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Label Station/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /RFID Station/ })).toBeTruthy();
  });

  it('the Label Station path is Move → Site → Scan type, counted out of 4, and sends station_type', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /Label Station/ }));
    expect(screen.getByText('Step 2 of 4 · Move')).toBeTruthy();
    await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
    expect(screen.getByText('Step 3 of 4 · Site')).toBeTruthy();
    await user.click(cardFor('NAP22 Hall'));
    expect(screen.getByText('Step 4 of 4 · Scan type')).toBeTruthy();
    await user.click(cardFor('RFID 1 - Cage Exit'));

    await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
      serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2',
      scan_status: 'rfid_1_cage_exit', station_type: 'label',
    }));
    expect(await screen.findByText('Label Station · Laptop')).toBeTruthy();
    expect(readKioskSetup()?.stationType).toBe('label');
    expect(readKioskSetup()?.reader).toBeUndefined();
    expect(apiMock.startReaderScan).not.toHaveBeenCalled();
  });

  it('the RFID path runs reader → connect → pair → placeholder → move → site → scan type', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));

    expect(screen.getByText('Step 2 of 8 · Select reader')).toBeTruthy();
    expect(await screen.findByText('10.0.0.5')).toBeTruthy();
    expect(apiMock.startReaderScan).toHaveBeenCalledTimes(1);
    expect(within(cardFor('10.0.0.6')).getByText('Already paired with Kiosk ABCD (Front desk)')).toBeTruthy();
    expect(within(cardFor('10.0.0.5')).queryByText(/Already paired/)).toBeNull();

    await user.click(cardFor('10.0.0.5'));
    expect(screen.getByText('Step 3 of 8 · Connect')).toBeTruthy();
    expect(apiMock.connectReader).toHaveBeenCalledWith('10.0.0.5');
    expect(await screen.findByText('1234ABCD')).toBeTruthy();
    expect(screen.getByText('FX9600')).toBeTruthy();
    expect(screen.getByText('3.10.30')).toBeTruthy();
    expect(screen.getByText('2.1.1')).toBeTruthy();
    expect(screen.getByText('3.0.12')).toBeTruthy();
    expect(screen.getByText('Radio connected · 2 of 4 antennas connected · up 26 days 01:11:17'))
      .toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    expect(screen.getByText('Step 4 of 8 · Pair')).toBeTruthy();
    expect(await screen.findByText('Paired with FX9600 1234ABCD at 10.0.0.5')).toBeTruthy();
    expect(apiMock.pairReader).toHaveBeenCalledWith({ ip: '10.0.0.5' });

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Step 5 of 8 · RFID settings')).toBeTruthy();
    expect(screen.getByText('RFID settings — coming soon')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Step 6 of 8 · Move')).toBeTruthy();
    await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
    expect(screen.getByText('Step 7 of 8 · Site')).toBeTruthy();
    await user.click(cardFor('NAP22 Hall'));
    expect(screen.getByText('Step 8 of 8 · Scan type')).toBeTruthy();
    await user.click(cardFor('RFID 1 - Cage Exit'));

    await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
      serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2',
      scan_status: 'rfid_1_cage_exit', station_type: 'rfid',
    }));
    expect(await screen.findByText('RFID · Laptop')).toBeTruthy();
    expect(screen.getByText('FX9600 1234ABCD at 10.0.0.5')).toBeTruthy();
    expect(readKioskSetup()).toMatchObject({
      stationType: 'rfid', reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
    });
  });

  it('Back works on every RFID step', async () => {
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 2 of 8 · Select reader')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 1 of 8 · Station type')).toBeTruthy();
    expect(cardFor('RFID Station').getAttribute('aria-selected')).toBe('true');

    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    await screen.findByText(/Paired with FX9600/);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 3 of 8 · Connect')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 4 of 8 · Pair')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Step 6 of 8 · Move')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 5 of 8 · RFID settings')).toBeTruthy();
  });

  it('a running scan shows its progress', async () => {
    apiMock.getReaderScan.mockReset()
      .mockResolvedValueOnce({ ...SCAN_DONE, state: 'running', probed: 64, total: 254, readers: [] })
      .mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('64');
    expect(bar.getAttribute('aria-valuemax')).toBe('254');
    expect(screen.getByText('Scanning this network… 64 of 254 addresses checked')).toBeTruthy();
  });

  it('Scan again restarts the scan', async () => {
    const user = userEvent.setup();
    renderPage();
    await toReaderStep(user);
    await user.click(screen.getByRole('button', { name: 'Scan again' }));
    await waitFor(() => expect(apiMock.startReaderScan).toHaveBeenCalledTimes(2));
  });

  it('a done scan with no readers says so', async () => {
    apiMock.getReaderScan.mockResolvedValue({ ...SCAN_DONE, readers: [] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    expect(await screen.findByText(/No FX readers found on this network/)).toBeTruthy();
  });

  it('Enter IP manually validates IPv4 before connecting', async () => {
    const user = userEvent.setup();
    renderPage();
    await toReaderStep(user);
    await user.click(screen.getByRole('button', { name: 'Enter IP manually' }));
    const field = screen.getByLabelText('Reader IP');
    await user.type(field, '10.0.0.300');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Enter a valid IPv4 address, like 192.168.1.20.')).toBeTruthy();
    expect(apiMock.connectReader).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, '10.0.0.77');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Step 3 of 8 · Connect')).toBeTruthy();
    expect(apiMock.connectReader).toHaveBeenCalledWith('10.0.0.77');
  });

  it('an unknown laptop address explains why and offers reader and laptop IP fields', async () => {
    apiMock.getReaderScan.mockResolvedValue({
      ...SCAN_DONE, state: 'failed', probed: 0, total: 0, readers: [], host: { ips: [], fresh: false },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    expect(await screen.findByText(/This laptop's network address isn't known yet/)).toBeTruthy();
    await user.type(screen.getByLabelText('Reader IP'), '10.0.0.5');
    await user.type(screen.getByLabelText('Laptop IP'), '10.0.0');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Enter a valid IPv4 address, like 192.168.1.20.')).toBeTruthy();
    await user.type(screen.getByLabelText('Laptop IP'), '.9');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    await screen.findByText(/Paired with FX9600/);
    expect(apiMock.pairReader).toHaveBeenCalledWith({ ip: '10.0.0.5', laptop_ip: '10.0.0.9' });
  });

  it.each([
    ['reader_auth_failed', "Couldn't sign in to this reader."],
    ['reader_not_iotc',
      "This reader isn't in IoT Connector (Local REST) mode — set it in the reader's web console."],
    ['reader_unreachable', "Can't reach 10.0.0.5."],
    ['reader_error', 'Antenna busy'],
    ['bad_ip', 'Enter a valid IPv4 address, like 192.168.1.20.'],
    ['network', "Can't reach this laptop's edge service. Try again."],
  ])('a %s connect error shows its message and Try again', async (code, text) => {
    apiMock.connectReader.mockReset()
      .mockRejectedValueOnce(new ApiError(502, code, { code, message: 'Antenna busy' }))
      .mockResolvedValue(CONNECTED);
    const user = userEvent.setup();
    renderPage();
    await toReaderStep(user);
    await user.click(cardFor('10.0.0.5'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair this reader' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1234ABCD')).toBeTruthy();
  });

  it('a reader held by another kiosk asks before taking it over', async () => {
    apiMock.pairReader.mockReset()
      .mockRejectedValueOnce(new ApiError(409, 'reader_paired_elsewhere',
        { code: 'reader_paired_elsewhere', name: 'ServerSherpa Kiosk ABCD (Front desk)' }))
      .mockResolvedValue(PAIRED);
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Kiosk ABCD (Front desk)')).toBeTruthy();
    expect(dialog.textContent).toContain('This reader is paired with Kiosk ABCD (Front desk). Pair it with this kiosk instead?');
    expect(dialog.textContent).toContain(
      'If that name is this laptop (for example after a reset), choose Pair anyway.');
    await user.click(within(dialog).getByRole('button', { name: 'Pair anyway' }));

    expect(await screen.findByText('Paired with FX9600 1234ABCD at 10.0.0.5')).toBeTruthy();
    expect(apiMock.pairReader).toHaveBeenLastCalledWith({ ip: '10.0.0.5', confirm_takeover: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel on the takeover confirm returns to Connect without pairing', async () => {
    apiMock.pairReader.mockReset().mockRejectedValue(new ApiError(409, 'reader_paired_elsewhere',
      { code: 'reader_paired_elsewhere', name: 'ServerSherpa Kiosk ABCD (Front desk)' }));
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Step 3 of 8 · Connect')).toBeTruthy();
    expect(screen.queryByText(/ServerSherpa Kiosk/)).toBeNull();
    expect(apiMock.pairReader).toHaveBeenCalledTimes(1);
  });

  it('a pair failure shows the reader message and Try again', async () => {
    apiMock.pairReader.mockReset()
      .mockRejectedValueOnce(new ApiError(502, 'reader_error', { code: 'reader_error', message: 'Config locked' }))
      .mockResolvedValue(PAIRED);
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    expect(await screen.findByText('Config locked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Paired with FX9600 1234ABCD at 10.0.0.5')).toBeTruthy();
  });

  it.each([
    ['reader_verify_failed', "The reader didn't keep the new data endpoint. Try again."],
  ])('a %s pair error shows its message', async (code, text) => {
    apiMock.pairReader.mockReset().mockRejectedValue(new ApiError(502,
      code, { code }));
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Back is disabled while Connect or Pair is waiting on the edge', async () => {
    let resolveConnect: (v: unknown) => void = () => {};
    apiMock.connectReader.mockReset().mockReturnValue(new Promise((r) => { resolveConnect = r; }));
    let resolvePair: (v: unknown) => void = () => {};
    apiMock.pairReader.mockReset().mockReturnValue(new Promise((r) => { resolvePair = r; }));
    const user = userEvent.setup();
    renderPage();
    await toReaderStep(user);
    await user.click(cardFor('10.0.0.5'));
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    resolveConnect(CONNECTED);
    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    resolvePair(PAIRED);
    await screen.findByText(/Paired with FX9600/);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('pairing with no known laptop address offers the reader and laptop IP fields', async () => {
    apiMock.pairReader.mockReset()
      .mockRejectedValueOnce(new ApiError(409, 'host_network_unknown', { code: 'host_network_unknown' }))
      .mockResolvedValue(PAIRED);
    const user = userEvent.setup();
    renderPage();
    await toConnectStep(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    expect(await screen.findByText("This laptop's network address isn't known yet. Re-run the install"
      + ' command, or enter the IPs below.')).toBeTruthy();
    expect((screen.getByLabelText('Reader IP') as HTMLInputElement).value).toBe('10.0.0.5');
    await user.type(screen.getByLabelText('Laptop IP'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    await screen.findByText(/Paired with FX9600/);
    expect(apiMock.pairReader).toHaveBeenLastCalledWith({ ip: '10.0.0.5', laptop_ip: '10.0.0.9' });
  });

  it('re-entering setup pre-selects the saved station type', async () => {
    writeKioskSetup({
      initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
      siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
      scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
      stationType: 'rfid', reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
    });
    writeSetupState('complete');
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('RFID · Laptop')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Change setup' }));
    expect(screen.getByText('Step 1 of 8 · Station type')).toBeTruthy();
    expect(cardFor('RFID Station').getAttribute('aria-selected')).toBe('true');
    expect(cardFor('Label Station').getAttribute('aria-selected')).toBe('false');
    // Cancel returns to the summary from the first step
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/This kiosk is set up for/)).toBeTruthy();
  });
});

it('web mode has no station-type step and sends no station_type', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('Step 1 of 3 · Move')).toBeTruthy();
  expect(screen.queryByText('What is this station?')).toBeNull();
  await goToScanStep(user);
  await user.click(cardFor('RFID 1 - Cage Exit'));
  await waitFor(() => expect(apiMock.submitKioskSetup).toHaveBeenCalledTimes(1));
  const payload = apiMock.submitKioskSetup.mock.calls[0][0] as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(payload, 'station_type')).toBe(false);
  expect(readKioskSetup()?.stationType).toBeUndefined();
});


// ── final fix round ────────────────────────────────────────────────

describe('laptop mode: final fix round', () => {
  beforeEach(() => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
    apiMock.startReaderScan.mockReset().mockResolvedValue({ scan_id: 'sc1' });
    apiMock.getReaderScan.mockReset().mockResolvedValue(SCAN_DONE);
    apiMock.connectReader.mockReset().mockResolvedValue(CONNECTED);
    apiMock.pairReader.mockReset().mockResolvedValue(PAIRED);
  });
  afterEach(() => { delete window.__KIOSK_CONFIG__; });

  async function toConnect(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    await user.click(cardFor(await screen.findByText('10.0.0.5').then((el) => el.textContent ?? '')));
    await screen.findByText('1234ABCD');
  }

  it('a Zebra reader the scan could not sign in to says so, and picking it connects', async () => {
    apiMock.getReaderScan.mockResolvedValue({
      ...SCAN_DONE,
      readers: [{ ip: '10.0.0.7', model: null, serial: null, paired_with: null, needs_connect: true,
                  scheme: 'http', port: 80 }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    const card = cardFor(await screen.findByText('10.0.0.7').then((el) => el.textContent ?? ''));
    expect(within(card).getByText('Zebra reader found — select it to connect')).toBeTruthy();
    expect(within(card).queryByText(/Serial/)).toBeNull();
    expect(card.textContent).not.toContain('null');
    await user.click(card);
    expect(screen.getByText('Step 3 of 8 · Connect')).toBeTruthy();
    expect(apiMock.connectReader).toHaveBeenCalledWith('10.0.0.7');
  });

  it('an offline sign-in is told Kiosk Setup needs the cloud, on Connect and on Pair', async () => {
    const offline = new ApiError(503, 'edge_offline', { code: 'edge_offline' });
    apiMock.connectReader.mockReset().mockRejectedValueOnce(offline).mockResolvedValue(CONNECTED);
    apiMock.pairReader.mockReset().mockRejectedValueOnce(offline).mockResolvedValue(PAIRED);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    await user.click(cardFor(await screen.findByText('10.0.0.5').then((el) => el.textContent ?? '')));
    expect(await screen.findByText('Kiosk Setup needs the cloud — try again when online.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    expect(await screen.findByText('Kiosk Setup needs the cloud — try again when online.')).toBeTruthy();
  });

  it('a reader off the laptop\'s subnets asks for the laptop IP to send to', async () => {
    apiMock.pairReader.mockReset()
      .mockRejectedValueOnce(new ApiError(409, 'reader_not_on_subnet', { code: 'reader_not_on_subnet' }))
      .mockResolvedValue(PAIRED);
    const user = userEvent.setup();
    renderPage();
    await toConnect(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    expect(await screen.findByText('Enter the IP address of this laptop that the reader should send to.'))
      .toBeTruthy();
    expect(screen.queryByText(/isn't known yet/)).toBeNull();
    await user.type(screen.getByLabelText('Laptop IP'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Pair this reader' }));
    await screen.findByText(/Paired with FX9600/);
    expect(apiMock.pairReader).toHaveBeenLastCalledWith({ ip: '10.0.0.5', laptop_ip: '10.0.0.9' });
  });

  it('the scan step\'s unknown-address copy no longer says to wait a minute', async () => {
    apiMock.getReaderScan.mockResolvedValue({
      ...SCAN_DONE, state: 'failed', probed: 0, total: 0, readers: [], host: { ips: [], fresh: false },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /RFID Station/ }));
    const hint = await screen.findByText(/This laptop's network address isn't known yet/);
    expect(hint.textContent).toContain('Re-run the install command, or enter the IPs below.');
    expect(hint.textContent).not.toContain('wait a minute');
  });

  it('reader_required on save says to pair a reader first, with a way back to the reader step', async () => {
    apiMock.submitKioskSetup.mockReset()
      .mockRejectedValue(new ApiError(422, 'reader_required', { code: 'reader_required' }));
    const user = userEvent.setup();
    renderPage();
    await toConnect(user);
    await user.click(screen.getByRole('button', { name: 'Pair this reader' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByText('NAP11 Hall Migration (demo)'));
    await user.click(cardFor('NAP22 Hall'));
    await user.click(cardFor('RFID 1 - Cage Exit'));
    expect(await screen.findByText('Pair a reader first')).toBeTruthy();
    expect(screen.queryByText(/reader_required/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to the reader step' }));
    expect(screen.getByText('Step 2 of 8 · Select reader')).toBeTruthy();
  });

  it('reached through a LAN address, Kiosk Setup says it changes the laptop itself', async () => {
    window.__KIOSK_CONFIG__ = { ...window.__KIOSK_CONFIG__, lanAccess: true };
    renderPage();
    expect(await screen.findByText("You're changing the setup of the laptop itself.")).toBeTruthy();
    cleanup();
    window.__KIOSK_CONFIG__ = { mode: 'laptop', lanAccess: false };
    renderPage();
    await screen.findByText('What is this station?');
    expect(screen.queryByText(/changing the setup of the laptop itself/)).toBeNull();
  });

  it('a shared setup that arrives after the page opened shows the summary', async () => {
    renderPage();
    await screen.findByText('What is this station?');
    act(() => {
      writeKioskSetup({
        initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
        siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
        scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit', stationType: 'label',
      });
      writeSetupState('complete');
    });
    expect(await screen.findByText(/This kiosk is set up for/)).toBeTruthy();
  });

  it('a shared setup never closes a wizard someone is already walking', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('option', { name: /Label Station/ }));
    act(() => {
      writeKioskSetup({
        initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
        siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
        scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
      });
      writeSetupState('complete');
    });
    expect(screen.getByText('Step 2 of 4 · Move')).toBeTruthy();
  });
});

it('web mode shows no LAN notice', async () => {
  window.__KIOSK_CONFIG__ = { lanAccess: true };
  renderPage();
  await screen.findByText('Step 1 of 3 · Move');
  expect(screen.queryByText(/changing the setup of the laptop itself/)).toBeNull();
  delete window.__KIOSK_CONFIG__;
});
