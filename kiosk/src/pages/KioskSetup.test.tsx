// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, getSetupOptions: apiMock.getSetupOptions, submitKioskSetup: apiMock.submitKioskSetup };
});

import { ApiError } from '../lib/api';
import { getIdentity } from '../lib/identity';
import { readKioskSetup } from '../lib/kioskSetup';
import { readSetupState } from '../lib/setupState';
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
