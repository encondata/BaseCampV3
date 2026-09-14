// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
      source_site: { id: 's-1', name: 'NAP11 Hall' },
      destination_site: { id: 's-2', name: 'NAP22 Hall' },
    },
    {
      id: 'i-2', name: 'NAP7 Rack Move', status: 'in_progress',
      source_site: null, destination_site: { id: 's-3', name: 'NAP7 Hall' },
    },
    {
      id: 'i-3', name: 'No Sites Move', status: 'planned',
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

it('loads options and renders them in the move select', async () => {
  renderPage();
  expect(screen.getByText('Loading moves…')).toBeTruthy();
  expect(await screen.findByRole('option', { name: 'NAP11 Hall Migration (demo) (planned)' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'NAP7 Rack Move' })).toBeTruthy();
});

it('Next is disabled until a move is chosen, then step 2 lists the move\'s sites with roles', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('option', { name: 'NAP7 Rack Move' });
  const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(next.disabled).toBe(true);

  await user.selectOptions(screen.getByLabelText('Move'), 'i-1');
  expect(next.disabled).toBe(false);
  await user.click(next);

  expect(screen.getByText('Step 2 of 3 · Site')).toBeTruthy();
  expect(screen.getByText('Which site is this kiosk at?')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'NAP11 Hall — source' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'NAP22 Hall — destination' })).toBeTruthy();
});

it('Site Next is disabled until a site is chosen, then step 3 shows scan types', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.selectOptions(await screen.findByLabelText('Move'), 'i-1');
  await user.click(screen.getByRole('button', { name: 'Next' }));

  const siteNext = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(siteNext.disabled).toBe(true);

  await user.selectOptions(screen.getByLabelText('Site'), 's-2');
  expect(siteNext.disabled).toBe(false);
  await user.click(siteNext);

  expect(screen.getByText('Step 3 of 3 · Scan type')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 1 - Cage Exit' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'RFID 2 - Dock' })).toBeTruthy();
});

it('a move with only a destination site skips the null source option', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.selectOptions(await screen.findByLabelText('Move'), 'i-2');
  await user.click(screen.getByRole('button', { name: 'Next' }));

  expect(screen.getByRole('option', { name: 'NAP7 Hall — destination' })).toBeTruthy();
  expect(screen.queryByText(/— source/)).toBeNull();
});

it('a move with no sites shows the copy and keeps Next disabled', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.selectOptions(await screen.findByLabelText('Move'), 'i-3');
  await user.click(screen.getByRole('button', { name: 'Next' }));

  expect(screen.getByText('This move has no sites yet. Ask a coordinator to add them.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('changing the move on step 1 clears the site choice', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.selectOptions(await screen.findByLabelText('Move'), 'i-1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.selectOptions(screen.getByLabelText('Site'), 's-2');
  await user.click(screen.getByRole('button', { name: 'Back' }));

  await user.selectOptions(screen.getByLabelText('Move'), 'i-2');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByLabelText('Site') as HTMLSelectElement).value).toBe('');
});

async function goToScanStep(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('Move'), 'i-1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.selectOptions(screen.getByLabelText('Site'), 's-2');
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

it('Finish submits the kiosk serial and chosen ids, saves the selection, and shows the summary', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.selectOptions(screen.getByLabelText('Scan type'), 'rfid_1_cage_exit');
  await user.click(screen.getByRole('button', { name: 'Finish' }));

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

it('a rejected submit sets failed and shows the inline error, staying on step 3', async () => {
  apiMock.submitKioskSetup.mockRejectedValue(new ApiError(500, 'server_error'));
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.selectOptions(screen.getByLabelText('Scan type'), 'rfid_1_cage_exit');
  await user.click(screen.getByRole('button', { name: 'Finish' }));

  expect(await screen.findByText("Couldn't save the kiosk setup (server_error). Try again.")).toBeTruthy();
  expect(readSetupState()).toBe('failed');
  expect(screen.getByLabelText('Scan type')).toBeTruthy();
});

it('shows empty-initiatives copy and keeps Next disabled', async () => {
  apiMock.getSetupOptions.mockResolvedValue({ initiatives: [], scan_types: OPTIONS.scan_types });
  renderPage();
  expect(await screen.findByText('No active moves. Ask a coordinator to plan one.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a load failure shows an error with Retry', async () => {
  apiMock.getSetupOptions.mockRejectedValueOnce(new ApiError(500, 'server_error'));
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText("Couldn't load setup options.")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('option', { name: 'NAP7 Rack Move' })).toBeTruthy();
});

it('Change setup re-enters the wizard at step 1, pre-selected', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.selectOptions(screen.getByLabelText('Scan type'), 'rfid_1_cage_exit');
  await user.click(screen.getByRole('button', { name: 'Finish' }));
  await screen.findByText(/This kiosk is set up for/);

  await user.click(screen.getByRole('button', { name: 'Change setup' }));
  expect(screen.getByText('Step 1 of 3 · Move')).toBeTruthy();
  await waitFor(() => expect((screen.getByLabelText('Move') as HTMLSelectElement).value).toBe('i-1'));
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);

  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByLabelText('Site') as HTMLSelectElement).value).toBe('s-2');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect((screen.getByLabelText('Scan type') as HTMLSelectElement).value).toBe('rfid_1_cage_exit');
});

it('"Go to home" navigates to /', async () => {
  const user = userEvent.setup();
  renderPage();
  await goToScanStep(user);
  await user.selectOptions(screen.getByLabelText('Scan type'), 'rfid_1_cage_exit');
  await user.click(screen.getByRole('button', { name: 'Finish' }));
  await screen.findByText(/This kiosk is set up for/);
  await user.click(screen.getByRole('button', { name: 'Go to home' }));
  expect(await screen.findByText('Home')).toBeTruthy();
});
