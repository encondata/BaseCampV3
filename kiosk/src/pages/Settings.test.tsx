// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const syncMock = vi.hoisted(() => ({
  status: { phase: 'idle' } as { phase: string; assets?: number; people?: number; syncedAt?: string },
  clearDb: vi.fn(() => Promise.resolve()),
  resetSyncStatus: vi.fn(),
}));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, useSyncStatus: () => syncMock.status, resetSyncStatus: syncMock.resetSyncStatus };
});
vi.mock('../lib/localDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/localDb')>();
  return { ...actual, clearDb: syncMock.clearDb };
});

const auth = vi.hoisted(() => ({
  status: 'authed', isAdmin: false, isDeveloper: false, heartbeatNow: vi.fn(() => Promise.resolve()),
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

// LocalDataInspector reads IndexedDB itself (see LocalDataInspector.test.tsx
// for that behavior); Settings.tsx only needs to know it renders on the
// Developer tab, so it's mocked here rather than seeding a fake database.
vi.mock('../components/LocalDataInspector', () => ({
  default: () => <div data-testid="local-data-inspector" />,
}));

import Settings from './Settings';

afterEach(() => {
  cleanup();
  auth.status = 'authed';
  auth.isAdmin = false;
  auth.isDeveloper = false;
  syncMock.status = { phase: 'idle' };
  syncMock.clearDb.mockClear();
  syncMock.resetSyncStatus.mockClear();
  localStorage.clear();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Settings />
    </MemoryRouter>,
  );
}

it('a worker sees Appearance, Sound, Devices, and This Kiosk — no Admin or Developer text', () => {
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
    'Appearance', 'Sound', 'Devices', 'This Kiosk',
  ]);
  expect(screen.queryByText('Admin')).toBeNull();
  expect(screen.queryByText('Developer')).toBeNull();
});

it('a developer sees all six tabs, This Kiosk after Devices', () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
    'Appearance', 'Sound', 'Devices', 'This Kiosk', 'Admin', 'Developer',
  ]);
});

it('clicking Sound selects it and shows its panel', async () => {
  renderAt('/settings');
  await userEvent.click(screen.getByRole('tab', { name: 'Sound' }));
  expect(screen.getByRole('tab', { name: 'Sound' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('false');
  expect(screen.getByRole('heading', { name: 'Sound' })).toBeTruthy();
});

it('a worker requesting the hidden admin tab falls back to Appearance', () => {
  renderAt('/settings?tab=admin');
  expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
});

it('an admin requesting ?tab=admin sees Admin selected', () => {
  auth.isAdmin = true;
  renderAt('/settings?tab=admin');
  expect(screen.getByRole('tab', { name: 'Admin' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Admin' })).toBeTruthy();
});

it('signed in, This Kiosk shows the serial field and no placeholder card', () => {
  renderAt('/settings?tab=this-kiosk');
  expect(screen.getByRole('tab', { name: 'This Kiosk' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByLabelText('Serial')).toBeTruthy();
  expect(screen.getByLabelText('Kiosk name')).toBeTruthy();
  expect(screen.queryByText('This section is not available yet.')).toBeNull();
});

it('signed out, only the This Kiosk tab and the name field are shown', () => {
  auth.status = 'anon';
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['This Kiosk']);
  expect(screen.getByRole('tab', { name: 'This Kiosk' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByLabelText('Kiosk name')).toBeTruthy();
});

it('signed out, requesting ?tab=admin still lands on This Kiosk', () => {
  auth.status = 'anon';
  renderAt('/settings?tab=admin');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['This Kiosk']);
  expect(screen.getByRole('tab', { name: 'This Kiosk' }).getAttribute('aria-selected')).toBe('true');
});

it('an admin/developer signed out still sees only This Kiosk', () => {
  auth.status = 'anon';
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['This Kiosk']);
});

it('a developer sees a Developer mode switch on the Developer tab, unchecked by default, that persists on click', async () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  const toggle = screen.getByRole('switch', { name: 'Developer mode' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');

  await userEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('ss.kiosk.devMode')).toBe('true');
});

it('a worker never sees the Developer mode switch, on any tab', () => {
  renderAt('/settings');
  expect(screen.queryByRole('switch', { name: 'Developer mode' })).toBeNull();
});

it('the kiosk setup state radiogroup is absent until developer mode is switched on', () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  expect(screen.queryByRole('radiogroup', { name: 'Kiosk setup state' })).toBeNull();
});

it('a developer with dev mode on sees the kiosk setup state radiogroup and can set it', async () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  await userEvent.click(screen.getByRole('switch', { name: 'Developer mode' }));

  const group = screen.getByRole('radiogroup', { name: 'Kiosk setup state' });
  const options = within(group).getAllByRole('radio');
  expect(options.map((o) => o.textContent)).toEqual(['Incomplete', 'Complete', 'Failed']);
  expect(screen.getByRole('radio', { name: 'Incomplete' }).getAttribute('aria-checked')).toBe('true');

  await userEvent.click(screen.getByRole('radio', { name: 'Complete' }));
  expect(screen.getByRole('radio', { name: 'Complete' }).getAttribute('aria-checked')).toBe('true');
  expect(localStorage.getItem('ss.kiosk.setupState')).toBe('complete');
});


it('the Local data row is absent until developer mode is switched on', () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  expect(screen.queryByText('Local data')).toBeNull();
});

it('a developer with dev mode on sees the local data counts and can clear them', async () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  syncMock.status = { phase: 'done', assets: 15, people: 4, syncedAt: '2026-09-13T18:14:00Z' };
  renderAt('/settings?tab=developer');
  await userEvent.click(screen.getByRole('switch', { name: 'Developer mode' }));

  expect(screen.getByText('Local data')).toBeTruthy();
  expect(screen.getByText(/15 assets · 4 people · synced /)).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Clear local data' }));
  expect(syncMock.clearDb).toHaveBeenCalled();
  expect(syncMock.resetSyncStatus).toHaveBeenCalled();
});

it('a clearDb failure shows an inline error and leaves the status untouched', async () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  syncMock.status = { phase: 'done', assets: 15, people: 4, syncedAt: '2026-09-13T18:14:00Z' };
  syncMock.clearDb.mockRejectedValue(new Error('boom'));
  renderAt('/settings?tab=developer');
  await userEvent.click(screen.getByRole('switch', { name: 'Developer mode' }));

  await userEvent.click(screen.getByRole('button', { name: 'Clear local data' }));

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't clear local data.");
  expect(syncMock.resetSyncStatus).not.toHaveBeenCalled();
  expect(screen.getByText(/15 assets · 4 people · synced /)).toBeTruthy();
});

it('the Local data row reads "Nothing downloaded yet" before a sync', async () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  await userEvent.click(screen.getByRole('switch', { name: 'Developer mode' }));
  expect(screen.getByText('Nothing downloaded yet.')).toBeTruthy();
});

it('a developer sees the local data inspector on the Developer tab', () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings?tab=developer');
  expect(screen.getByTestId('local-data-inspector')).toBeTruthy();
});

it('the Appearance tab shows both scan-flash pickers and persists a change', async () => {
  renderAt('/settings?tab=appearance');
  expect(screen.getByText('Good scan flash')).toBeTruthy();
  expect(screen.getByText('Not-found scan flash')).toBeTruthy();
  expect(screen.getByLabelText('Good scan flash hue')).toBeTruthy();
  expect(screen.getByLabelText('Not-found scan flash lightness')).toBeTruthy();
  expect(screen.getByText('hsl(150 60% 45%)')).toBeTruthy();
  expect(screen.getByText('hsl(0 70% 50%)')).toBeTruthy();
  expect(screen.queryByText('This section is not available yet.')).toBeNull();

  fireEvent.change(screen.getByLabelText('Good scan flash hue'), { target: { value: '210' } });
  expect(screen.getByText('hsl(210 60% 45%)')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('ss.kiosk.appearance')!).good_scan)
    .toEqual({ h: 210, s: 60, l: 45 });
});
