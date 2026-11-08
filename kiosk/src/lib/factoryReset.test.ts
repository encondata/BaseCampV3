// @vitest-environment jsdom
/** Clear Setup (Settings › Developer): back to out-of-box for testing,
 *  keeping only who this kiosk is. Against a real (fake) IndexedDB and
 *  real localStorage, with the network calls stubbed. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ laptop: false }));
vi.mock('./platform', async (importActual) => ({
  ...(await importActual<typeof import('./platform')>()),
  isLaptop: () => platform.laptop,
}));
const remote = vi.hoisted(() => ({
  edgeWipe: vi.fn(() => Promise.resolve({ cleared_move_data: true })),
  getEdgeStatus: vi.fn(),
}));
vi.mock('./api', async (importActual) => ({
  ...(await importActual<typeof import('./api')>()),
  edgeWipe: remote.edgeWipe,
  getEdgeStatus: remote.getEdgeStatus,
}));
const laptopCfg = vi.hoisted(() => ({ flushLaptopConfig: vi.fn(() => Promise.resolve()) }));
vi.mock('./laptopConfig', async (importActual) => ({
  ...(await importActual<typeof import('./laptopConfig')>()),
  flushLaptopConfig: laptopCfg.flushLaptopConfig,
}));

import { DEFAULT_APPEARANCE, readAppearance, writeAppearance } from './appearance';
import { CHECKPOINT_IDS, defaultCheckpoint, readCheckpoint, writeCheckpoint } from './checkpointSettings';
import { readDevMode, writeDevMode } from './devMode';
import { countUnsent, runClearSetup } from './factoryReset';
import { getIdentity, setKioskName } from './identity';
import { installConfigTracking, readConfigState } from './kioskConfig';
import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { closeDb, count, getAll, putRows } from './localDb';
import { readSetupState, writeSetupState } from './setupState';
import { DEFAULT_SOUND_SETTINGS, readSoundSettings, writeSoundSettings } from './sound';

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

function deps() {
  return { heartbeatNow: vi.fn(() => Promise.resolve()), logout: vi.fn(() => Promise.resolve()) };
}

/** A kiosk somebody has used: set up, customized, with data and queued scans. */
async function usedKiosk(): Promise<void> {
  writeKioskSetup(SETUP);
  writeSetupState('complete');
  writeAppearance({ flash_ms: 900 });
  writeSoundSettings({ volume: 0.2 });
  writeCheckpoint('enroll', 'staged');
  writeDevMode(true);
  localStorage.setItem('ss.kiosk.labelPrinting', '{"dpi":300}');
  localStorage.setItem('ss.kiosk.tcKeyboard', 'abc');
  localStorage.setItem('labels.print.settings', '{"offset":4}');
  await putRows('assets', [{ id: 'a-1', asset_id: '10042', name: 'Switch', rfid: null, serial_number: 'SN', make_model: '' }]);
  await putRows('outbox', [
    { client_scan_id: 's-1', status: 'queued', seq: 1 },
    { client_scan_id: 's-2', status: 'failed', seq: 2 },
    { client_scan_id: 's-3', status: 'accepted', seq: 3 },
    { client_scan_id: 's-4', status: 'nomatch', seq: 4 },
  ] as never[]);
  await putRows('sounds', [{ id: 'snd-1', name: 'beep.wav' }] as never[]);
}

beforeEach(() => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  platform.laptop = false;
  vi.clearAllMocks();
});
afterEach(() => { closeDb(); });

it('puts the kiosk back to out-of-box: no setup, default settings, no local data', async () => {
  await usedKiosk();
  await runClearSetup(deps());

  expect(readKioskSetup()).toBeNull();
  expect(readSetupState()).toBe('incomplete');
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  expect(readSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  for (const id of CHECKPOINT_IDS) expect(readCheckpoint(id)).toBe(defaultCheckpoint(id));
  expect(readDevMode()).toBe(false);
  expect(localStorage.getItem('ss.kiosk.labelPrinting')).toBeNull();
  expect(localStorage.getItem('ss.kiosk.tcKeyboard')).toBeNull();
  expect(localStorage.getItem('labels.print.settings')).toBeNull();

  expect(await getAll('assets')).toEqual([]);
  // unlike "Clear local data", unsent scans and uploaded sounds go too
  expect(await getAll('outbox')).toEqual([]);
  expect(await getAll('sounds')).toEqual([]);
});

it('keeps who this kiosk is: the same name and serial', async () => {
  setKioskName('Dock 3');
  const before = getIdentity();
  await usedKiosk();
  await runClearSetup(deps());
  expect(getIdentity()).toEqual(before);
  expect(getIdentity().name).toBe('Dock 3');
});

it('records the defaults as a change, so they win at the next check-in instead of the portal copy', async () => {
  await usedKiosk();
  // pretend the last report went out, so nothing was owed before the reset
  localStorage.setItem('ss.kiosk.configSync', JSON.stringify({
    ...readConfigState(), dirty: false, applied_version: 7, server_offset_ms: 0,
  }));
  // the running app installs this at startup (main.tsx); a test must too
  const stopTracking = installConfigTracking();
  try {
    await runClearSetup(deps());
  } finally {
    stopTracking();
  }
  const st = readConfigState();
  expect(st.dirty).toBe(true);
  expect(st.applied_version).toBe(7);    // the sync bookkeeping survives the wipe
});

it('on a web kiosk, reports now and signs out', async () => {
  const d = deps();
  await runClearSetup(d);
  expect(d.heartbeatNow).toHaveBeenCalledTimes(1);
  expect(d.logout).toHaveBeenCalledTimes(1);
  expect(remote.edgeWipe).not.toHaveBeenCalled();
});

it('a failed report or sign-out does not stop the reset (offline testing)', async () => {
  await usedKiosk();
  const d = { heartbeatNow: vi.fn(() => Promise.reject(new Error('offline'))),
    logout: vi.fn(() => Promise.reject(new Error('offline'))) };
  await runClearSetup(d);
  expect(readKioskSetup()).toBeNull();
  expect(await getAll('assets')).toEqual([]);
});

it('on a laptop, hands the defaults to the laptop first, then wipes the laptop as well', async () => {
  platform.laptop = true;
  const order: string[] = [];
  laptopCfg.flushLaptopConfig.mockImplementationOnce(() => { order.push('flush'); return Promise.resolve(); });
  remote.edgeWipe.mockImplementationOnce(() => { order.push('wipe'); return Promise.resolve({ cleared_move_data: true }); });
  const d = deps();
  await usedKiosk();
  await runClearSetup(d);
  expect(order).toEqual(['flush', 'wipe']);
  // forced: the person already confirmed losing unsent data
  expect(remote.edgeWipe).toHaveBeenCalledWith('WIPE');
  expect(d.heartbeatNow).not.toHaveBeenCalled();   // the laptop syncs its own config
  expect(readKioskSetup()).toBeNull();
});

it('on a laptop, a failed wipe stops before the browser is cleared, and says so', async () => {
  platform.laptop = true;
  remote.edgeWipe.mockRejectedValueOnce(new Error('edge down'));
  await usedKiosk();
  await expect(runClearSetup(deps())).rejects.toThrow();
  // a browser-only reset would be refilled from the laptop, so nothing local went
  expect(await getAll('assets')).not.toEqual([]);
  expect(readKioskSetup()).not.toBeNull();
});

it('counts what is still unsent: queued, sending, retrying and failed — not sent or unmatched', async () => {
  await usedKiosk();
  expect(await countUnsent()).toBe(2);
});

it('on a laptop, adds what the laptop itself still holds', async () => {
  platform.laptop = true;
  await usedKiosk();
  remote.getEdgeStatus.mockResolvedValueOnce({
    outbox: { queued: 3, sending: 1, accepted: 9, retrying: 1, failed: 2, nomatch: 4 },
    rfid_uploads: { pending: 5, waiting_for_internet: 1, accepted: 40, rejected: 0 },
  });
  expect(await countUnsent()).toBe(2 + 3 + 1 + 1 + 2 + 5 + 1);
});

it('a laptop that cannot be asked still reports the browser count', async () => {
  platform.laptop = true;
  await usedKiosk();
  remote.getEdgeStatus.mockRejectedValueOnce(new Error('edge down'));
  expect(await countUnsent()).toBe(2);
});

it('Clear Setup empties label_bundles and the kiosk list settings', async () => {
  await putRows('label_bundles', [{ key: 'i-1:top', initiative_id: 'i-1', label_type: 'top' }]);
  localStorage.setItem('ss.kiosk.listPrefs', '{"list_size":"large"}');
  await runClearSetup(deps());
  expect(await count('label_bundles')).toBe(0);
  expect(localStorage.getItem('ss.kiosk.listPrefs')).toBeNull();
});
