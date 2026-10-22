// @vitest-environment jsdom
/** Kiosk Setup's Time Clock path (laptop only): Station type → Move
 *  (optional) → Site, with no scan type and no local-data download. */
import { cleanup, render, screen, within } from '@testing-library/react';
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
import { readKioskSetup, writeKioskSetup, type KioskSetupSelection } from '../lib/kioskSetup';
import { readSetupState, writeSetupState } from '../lib/setupState';
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
  scan_types: [{ key: 'rfid_1_cage_exit', label: 'RFID 1 - Cage Exit', color: '#123' }],
  sites: [
    { id: 's-1', name: 'NAP11 Hall' },
    { id: 's-2', name: 'NAP22 Hall' },
    { id: 's-9', name: 'Yard Office' },
  ],
};

const NO_MOVE_RESULT = {
  device_id: 'd-1', initiative_id: null, initiative_name: null,
  site_id: null, site_name: null, site_role: null, scan_status: null, scan_status_label: null,
};

beforeEach(() => {
  auth.kioskMove = null;
  localStorage.clear();
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  apiMock.getSetupOptions.mockReset().mockResolvedValue(OPTIONS);
  apiMock.submitKioskSetup.mockReset().mockResolvedValue(NO_MOVE_RESULT);
  apiMock.getLabelStation.mockReset().mockResolvedValue(null);
  syncMock.runSync.mockClear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<KioskSetup />} />
        <Route path="/" element={<div>Home</div>} />
        <Route path="/timeclock/station" element={<div>Start time clock page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function cardFor(title: string): HTMLElement {
  const button = screen.getByText(title).closest('button');
  if (!button) throw new Error(`no card button found for "${title}"`);
  return button;
}

const cardTitles = (list: string) => within(screen.getByRole('listbox', { name: list }))
  .getAllByRole('option').map((o) => o.querySelector('.setup-card-title')?.textContent);

async function toMoveStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('option', { name: /Time Clock/ }));
  await screen.findByText('NAP11 Hall Migration (demo)');
}

it('step 1 offers a third card, Time Clock, with its next steps', async () => {
  renderPage();
  const card = await screen.findByRole('option', { name: /Time Clock/ });
  expect(within(card).getByText('Time Clock')).toBeTruthy();
  expect(within(card).getByText('Workers clock in and out here. Next: Move (optional) → Site.')).toBeTruthy();
  expect(screen.getByRole('option', { name: /Label Station/ })).toBeTruthy();
  expect(screen.getByRole('option', { name: /RFID Station/ })).toBeTruthy();
});

it('the Time Clock path is Move → Site, counted out of 3, with No move first', async () => {
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  expect(screen.getByText('Step 2 of 3 · Move')).toBeTruthy();
  expect(cardTitles('Moves')).toEqual(['No move', 'NAP11 Hall Migration (demo)']);
  expect(within(cardFor('No move'))
    .getByText('Punches are filed under no move and sorted out later in the portal.')).toBeTruthy();
});

it('No move lists every site with No site first', async () => {
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  await user.click(cardFor('No move'));
  expect(screen.getByText('Step 3 of 3 · Site')).toBeTruthy();
  expect(cardTitles('Sites')).toEqual(['No site', 'NAP11 Hall', 'NAP22 Hall', 'Yard Office']);
  expect(screen.queryByText('SOURCE')).toBeNull();
  expect(screen.queryByText(/Scan type/)).toBeNull();
});

it('No move + No site posts nulls, saves the selection, and goes to Start Time Clock', async () => {
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  await user.click(cardFor('No move'));
  await user.click(cardFor('No site'));

  expect(await screen.findByText('Start time clock page')).toBeTruthy();
  expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: null, site_id: null, station_type: 'timeclock',
  });
  expect(readKioskSetup()).toEqual({
    initiativeId: '', initiativeName: 'No move', siteId: '', siteName: 'No site', siteRole: 'none',
    scanStatus: '', scanLabel: '', stationType: 'timeclock',
  });
  expect(readSetupState()).toBe('complete');
  expect(syncMock.runSync).not.toHaveBeenCalled();
});

it('No move + a site posts the site and saves it as other', async () => {
  apiMock.submitKioskSetup.mockResolvedValue({
    ...NO_MOVE_RESULT, site_id: 's-9', site_name: 'Yard Office', site_role: 'other',
  });
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  await user.click(cardFor('No move'));
  await user.click(cardFor('Yard Office'));

  expect(await screen.findByText('Start time clock page')).toBeTruthy();
  expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: null, site_id: 's-9', station_type: 'timeclock',
  });
  expect(readKioskSetup()).toMatchObject({
    initiativeId: '', initiativeName: 'No move', siteId: 's-9', siteName: 'Yard Office', siteRole: 'other',
  });
});

it('a move offers only its own sites, never No site, and posts no scan type', async () => {
  apiMock.submitKioskSetup.mockResolvedValue({
    ...NO_MOVE_RESULT, initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration (demo)',
    site_id: 's-2', site_name: 'NAP22 Hall', site_role: 'destination',
  });
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  await user.click(cardFor('NAP11 Hall Migration (demo)'));
  expect(cardTitles('Sites')).toEqual(['NAP11 Hall', 'NAP22 Hall']);
  expect(screen.getByText('SOURCE')).toBeTruthy();
  await user.click(cardFor('NAP22 Hall'));

  expect(await screen.findByText('Start time clock page')).toBeTruthy();
  expect(apiMock.submitKioskSetup).toHaveBeenCalledWith({
    serial: 'kiosk-laptop-1', initiative_id: 'i-1', site_id: 's-2', station_type: 'timeclock',
  });
  expect(readKioskSetup()).toMatchObject({
    initiativeId: 'i-1', siteId: 's-2', siteRole: 'destination', stationType: 'timeclock',
  });
  expect(syncMock.runSync).not.toHaveBeenCalled();
});

it('a save failure stays on the Site step and says so', async () => {
  apiMock.submitKioskSetup.mockRejectedValue(new ApiError(422, 'bad_site'));
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  await user.click(cardFor('No move'));
  await user.click(cardFor('Yard Office'));

  expect((await screen.findByRole('alert')).textContent)
    .toBe("Couldn't save the kiosk setup (bad_site). Try again.");
  expect(screen.getByText('Step 3 of 3 · Site')).toBeTruthy();
  expect(readSetupState()).toBe('failed');
});

function saveTimeclock(over: Partial<KioskSetupSelection> = {}) {
  writeKioskSetup({
    initiativeId: '', initiativeName: 'No move', siteId: '', siteName: 'No site', siteRole: 'none',
    scanStatus: '', scanLabel: '', stationType: 'timeclock', ...over,
  });
  writeSetupState('complete');
}

it('the summary of a Time Clock station with no move or site says so, with no local-data line', async () => {
  saveTimeclock();
  const { container } = renderPage();
  const summary = await screen.findByText(/This kiosk is a Time Clock station for/);
  expect(summary.textContent).toBe('This kiosk is a Time Clock station for no move at no site.');
  expect(summary.querySelectorAll('b')).toHaveLength(2);
  expect(screen.getByText('Time Clock · Laptop')).toBeTruthy();
  expect(container.querySelector('.sync-status')).toBeNull();
  expect(screen.queryByText(/scan type/)).toBeNull();
});

it('the summary of a Time Clock station names its move and site', async () => {
  saveTimeclock({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    siteId: 's-2', siteName: 'NAP22 Hall', siteRole: 'destination',
  });
  renderPage();
  const summary = await screen.findByText(/This kiosk is a Time Clock station for/);
  expect(summary.textContent)
    .toBe('This kiosk is a Time Clock station for NAP11 Hall Migration (demo) at NAP22 Hall.');
});

it('Change setup on a no-move station preselects Time Clock and No move', async () => {
  saveTimeclock({ siteId: 's-9', siteName: 'Yard Office', siteRole: 'other' });
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 3 · Station type')).toBeTruthy();
  expect(cardFor('Time Clock').getAttribute('aria-selected')).toBe('true');
  await user.click(cardFor('Time Clock'));
  await screen.findByText('NAP11 Hall Migration (demo)');
  expect(cardFor('No move').getAttribute('aria-selected')).toBe('true');
  expect(cardFor('NAP11 Hall Migration (demo)').getAttribute('aria-selected')).toBe('false');
  await user.click(cardFor('No move'));
  expect(cardFor('Yard Office').getAttribute('aria-selected')).toBe('true');
  expect(cardFor('No site').getAttribute('aria-selected')).toBe('false');
});

it('web mode offers no No move card', async () => {
  delete window.__KIOSK_CONFIG__;
  renderPage();
  await screen.findByText('NAP11 Hall Migration (demo)');
  expect(screen.queryByText('No move')).toBeNull();
});

it('a move-password session gets no No move card (it is locked to its move)', async () => {
  auth.kioskMove = { initiative_id: 'i-1', name: 'NAP11 Hall Migration (demo)' };
  apiMock.getSetupOptions.mockResolvedValue({ ...OPTIONS, sites: [] });
  const user = userEvent.setup();
  renderPage();
  await toMoveStep(user);
  expect(cardTitles('Moves')).toEqual(['NAP11 Hall Migration (demo)']);
  expect(screen.queryByText('No move')).toBeNull();
});
