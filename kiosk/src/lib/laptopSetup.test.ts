// @vitest-environment jsdom
/** A laptop's browsers share its finished Kiosk Setup (D2): a browser with
 *  no complete local setup loads the laptop's from GET /edge/setup and
 *  downloads the move data, as Kiosk Setup does after saving. Web mode
 *  never asks. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ getEdgeSetup: vi.fn() }));
vi.mock('./api', async (orig) => ({ ...(await orig<object>()), ...apiMock }));
const syncMock = vi.hoisted(() => ({ runSync: vi.fn(() => Promise.resolve()) }));
vi.mock('./sync', async (orig) => ({ ...(await orig<object>()), runSync: syncMock.runSync }));

import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { hydrateLaptopSetup } from './laptopSetup';
import { readSetupState, writeSetupState } from './setupState';

const SHARED = {
  initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration', site_id: 's-2',
  site_name: 'NAP22 Hall', site_role: 'destination', scan_status: 'rfid_1_cage_exit',
  scan_status_label: 'RFID 1 - Cage Exit', station_type: 'rfid',
  reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600',
            versions: { readerApplication: '3.10.30' } },
  updated_at: '2026-10-01T18:00:00+00:00',
};

const LOCAL = {
  initiativeId: 'i-9', initiativeName: 'Local Move', siteId: 's-9', siteName: 'Here',
  siteRole: 'source' as const, scanStatus: 'x', scanLabel: 'X',
};

beforeEach(() => {
  localStorage.clear();
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  apiMock.getEdgeSetup.mockReset().mockResolvedValue(SHARED);
  syncMock.runSync.mockClear();
});
afterEach(() => { delete window.__KIOSK_CONFIG__; });

it('a laptop browser with no setup loads the laptop\'s, then downloads the move data', async () => {
  expect(await hydrateLaptopSetup()).toBe(true);
  expect(readKioskSetup()).toEqual({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-2',
    siteName: 'NAP22 Hall', siteRole: 'destination', scanStatus: 'rfid_1_cage_exit',
    scanLabel: 'RFID 1 - Cage Exit', stationType: 'rfid',
    reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
  });
  expect(readSetupState()).toBe('complete');
  expect(syncMock.runSync).toHaveBeenCalledWith('i-1', 'NAP11 Hall Migration');
});

it('a label station carries no reader', async () => {
  apiMock.getEdgeSetup.mockResolvedValue({ ...SHARED, station_type: 'label', reader: null });
  await hydrateLaptopSetup();
  expect(readKioskSetup()?.stationType).toBe('label');
  expect(readKioskSetup()?.reader).toBeUndefined();
});

it('an incomplete local setup is replaced by the laptop\'s', async () => {
  writeKioskSetup(LOCAL);
  writeSetupState('failed');
  expect(await hydrateLaptopSetup()).toBe(true);
  expect(readKioskSetup()?.initiativeId).toBe('i-1');
  expect(readSetupState()).toBe('complete');
});

it('a complete local setup is left alone and the edge is not asked', async () => {
  writeKioskSetup(LOCAL);
  writeSetupState('complete');
  expect(await hydrateLaptopSetup()).toBe(false);
  expect(apiMock.getEdgeSetup).not.toHaveBeenCalled();
  expect(readKioskSetup()?.initiativeId).toBe('i-9');
  expect(syncMock.runSync).not.toHaveBeenCalled();
});

it('a laptop never set up (null), a bad answer or a failed call changes nothing', async () => {
  apiMock.getEdgeSetup.mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ initiative_id: 'i-1' })
    .mockRejectedValueOnce(new Error('offline'));
  for (let i = 0; i < 3; i += 1) expect(await hydrateLaptopSetup()).toBe(false);
  expect(readKioskSetup()).toBeNull();
  expect(readSetupState()).toBe('incomplete');
  expect(syncMock.runSync).not.toHaveBeenCalled();
});

it('web mode never asks the edge and keeps its own setup', async () => {
  window.__KIOSK_CONFIG__ = {};
  expect(await hydrateLaptopSetup()).toBe(false);
  writeKioskSetup(LOCAL);
  expect(await hydrateLaptopSetup()).toBe(false);
  expect(apiMock.getEdgeSetup).not.toHaveBeenCalled();
  expect(readKioskSetup()?.initiativeId).toBe('i-9');
  expect(readSetupState()).toBe('incomplete');
});

it('a setup finished locally while the edge answered wins', async () => {
  let answer: (v: unknown) => void = () => {};
  apiMock.getEdgeSetup.mockReturnValue(new Promise((r) => { answer = r; }));
  const pending = hydrateLaptopSetup();
  writeKioskSetup(LOCAL);
  writeSetupState('complete');
  answer(SHARED);
  expect(await pending).toBe(false);
  expect(readKioskSetup()?.initiativeId).toBe('i-9');
});
