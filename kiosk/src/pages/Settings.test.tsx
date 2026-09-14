// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

const apiMock = vi.hoisted(() => ({ getSetupOptions: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, getSetupOptions: apiMock.getSetupOptions };
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

import { closeDb } from '../lib/localDb';
import { resetSoundAudioForTest } from '../lib/sound';
import Settings from './Settings';

// jsdom has no Web Audio API and never plays an <audio> element; the
// Sound tab's Play buttons only need to be provably wired, so a minimal
// fake stands in (see lib/sound.test.ts for the tones themselves).
const audioContexts = vi.fn();

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  constructor() { audioContexts(); }
  resume() { return Promise.resolve(); }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, start() {}, stop() {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
}

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetSoundAudioForTest();
  apiMock.getSetupOptions.mockReset().mockResolvedValue({
    initiatives: [],
    scan_types: [
      { key: 'pre_stage', label: 'Pre-Stage', color: '#336699' },
      { key: 'cage_exit', label: 'RFID 1 - Cage Exit', color: '#996633' },
    ],
  });
  audioContexts.mockClear();
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

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

it('the Appearance tab sets how long the flash lasts, and persists it', () => {
  renderAt('/settings?tab=appearance');
  expect(screen.getByText('Flash duration')).toBeTruthy();
  expect(screen.getByText('350 ms')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Flash duration'), { target: { value: '1000' } });
  expect(screen.getByText('1000 ms')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('ss.kiosk.appearance')!).flash_ms).toBe(1000);
});

it('the Sound tab picks a sound per scan outcome, previews it, and persists the choice', async () => {
  renderAt('/settings?tab=sound');
  const good = screen.getByLabelText('Good scan sound') as HTMLSelectElement;
  const notFound = screen.getByLabelText('Not-found scan sound') as HTMLSelectElement;
  expect(good.value).toBe('builtin:chime');
  expect(notFound.value).toBe('builtin:buzz');
  expect([...good.options].map((o) => o.textContent))
    .toEqual(['None', 'Chime', 'Beep', 'Double beep', 'Buzz', 'Bonk']);
  expect(screen.queryByText('This section is not available yet.')).toBeNull();

  fireEvent.change(good, { target: { value: 'builtin:double_beep' } });
  expect(JSON.parse(localStorage.getItem('ss.kiosk.sound')!).good)
    .toEqual({ kind: 'builtin', id: 'double_beep' });

  fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '40' } });
  expect(screen.getByText('40%')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('ss.kiosk.sound')!).volume).toBeCloseTo(0.4);

  // Play previews the current choice — it must reach the audio API.
  await userEvent.click(within(good.closest('.settings-row') as HTMLElement).getByRole('button', { name: 'Play' }));
  expect(audioContexts).toHaveBeenCalled();
});

it('the Sound tab uploads a sound, offers it as a choice, and removes it', async () => {
  renderAt('/settings?tab=sound');
  expect(screen.getByText('MP3, WAV, or OGG up to 2 MB. Stored on this kiosk only.')).toBeTruthy();

  const file = new File([new Uint8Array(2048)], 'ding.wav', { type: 'audio/wav' });
  await userEvent.upload(screen.getByLabelText('Upload sound'), file);

  // The name shows up twice once the upload lands: in the list, and as
  // an option under the selects' "Uploaded" group.
  const name = await screen.findByTitle('ding.wav');
  const row = name.closest('.sound-upload-row') as HTMLElement;
  expect(within(row).getByText('2 KB')).toBeTruthy();
  expect(
    [...(screen.getByLabelText('Good scan sound') as HTMLSelectElement).options]
      .map((o) => o.textContent),
  ).toContain('ding.wav');

  await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByTitle('ding.wav')).toBeNull());
  expect(screen.queryByText('ding.wav')).toBeNull();   // gone from the selects too
});

it('the Sound tab refuses a file that is too big or is not audio', async () => {
  renderAt('/settings?tab=sound');
  const input = screen.getByLabelText('Upload sound');

  await userEvent.upload(
    input, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'long.wav', { type: 'audio/wav' }));
  expect(await screen.findByText('That file is too large (2 MB max).')).toBeTruthy();

  // `accept` keeps a non-audio file out of the picker in a real browser;
  // the guard behind it is what this checks.
  await userEvent.upload(
    input, new File(['nope'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false });
  expect(await screen.findByText("That doesn't look like an audio file.")).toBeTruthy();
  expect(screen.queryByText('notes.txt')).toBeNull();
});

it('the Admin tab offers the RFID Enroll checkpoint, defaulting to Pre-Stage, and persists a change', async () => {
  auth.isAdmin = true;
  renderAt('/settings?tab=admin');

  const select = await screen.findByLabelText('RFID Enroll checkpoint') as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBe(2));
  expect(select.value).toBe('pre_stage');
  expect([...select.options].map((o) => o.textContent)).toEqual(['Pre-Stage', 'RFID 1 - Cage Exit']);
  expect(screen.getByText('The scan type recorded when a tag is enrolled.')).toBeTruthy();

  await userEvent.selectOptions(select, 'cage_exit');
  expect(localStorage.getItem('ss.kiosk.enrollStatus')).toBe('cage_exit');
  expect((screen.getByLabelText('RFID Enroll checkpoint') as HTMLSelectElement).value).toBe('cage_exit');
});

it('a stored checkpoint the portal no longer offers falls back to the default', async () => {
  auth.isAdmin = true;
  localStorage.setItem('ss.kiosk.enrollStatus', 'retired_checkpoint');
  renderAt('/settings?tab=admin');

  const select = await screen.findByLabelText('RFID Enroll checkpoint') as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('pre_stage'));
});

it('a worker never sees the RFID Enroll checkpoint row, on any tab', () => {
  renderAt('/settings?tab=admin');
  expect(screen.queryByLabelText('RFID Enroll checkpoint')).toBeNull();
  expect(screen.queryByText('RFID Enroll checkpoint')).toBeNull();
});

it('the Admin tab says so when the checkpoint list cannot be loaded', async () => {
  auth.isAdmin = true;
  apiMock.getSetupOptions.mockRejectedValueOnce(new Error('offline'));
  renderAt('/settings?tab=admin');
  expect(await screen.findByText(
    "Couldn't load the checkpoint list. The stored choice still applies.",
  )).toBeTruthy();
});
