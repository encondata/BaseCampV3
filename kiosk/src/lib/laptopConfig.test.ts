// @vitest-environment jsdom
/**
 * Laptop mode: the edge holds the laptop's kiosk config. Each browser polls
 * GET /edge/config, applies a new version, seeds the edge when it has none,
 * and sends its own edits through PUT /edge/config (merging when another
 * browser got there first). The API is mocked at `./api`.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  heartbeatRequest: vi.fn(),
  getEdgeConfig: vi.fn(),
  putEdgeConfig: vi.fn(),
  uploadKioskSound: vi.fn(),
  downloadKioskSound: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, ...api };
});

import { ApiError } from './api';
import { readAppearance, writeAppearance } from './appearance';
import { readDevMode, writeDevMode } from './devMode';
import {
  collectConfig, handleConfigReply, readConfigState, resetConfigSyncForTest,
} from './kioskConfig';
import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import {
  pollEdgeConfig, resetLaptopConfigForTest, startLaptopConfigSync,
} from './laptopConfig';
import { closeDb } from './localDb';
import { resetSoundAudioForTest } from './sound';

const PORTAL_DOC = {
  schema: 1,
  appearance: {
    good_scan: { h: 200, s: 50, l: 40 }, not_found_scan: { h: 0, s: 70, l: 50 },
    duplicate_scan: { h: 38, s: 92, l: 50 }, flash_ms: 900,
  },
  sound: {
    good: { kind: 'builtin', id: 'chime' }, not_found: { kind: 'builtin', id: 'buzz' },
    duplicate: { kind: 'builtin', id: 'double_beep' }, alarm: { kind: 'siren' }, volume: 0.5,
  },
  checkpoints: {
    enroll: 'pre_stage', container_pack: 'in_container', container_unpack: 'un_pack',
    truck_load: 'on_truck', truck_unload: 'received',
  },
  developer: { dev_mode: false },
  alarm: { mode: 'timed', timed_seconds: 42 },
  android_rfid: { power: 270, nested: { a: [1, 2, { b: null }] } },
  ios: { camera_position: 'front' },
  future_thing: { n: 1.5 },
};

const setLaptop = () => {
  (window as unknown as { __KIOSK_CONFIG__: unknown }).__KIOSK_CONFIG__ = { mode: 'laptop' };
};

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  resetConfigSyncForTest();
  resetLaptopConfigForTest();
  resetSoundAudioForTest();
  for (const fn of Object.values(api)) fn.mockReset();
  api.downloadKioskSound.mockRejectedValue(new ApiError(0, 'network'));
  api.putEdgeConfig.mockImplementation(({ doc }: { doc: unknown }) =>
    Promise.resolve({ doc, version: 1, changed_at: null }));
  setLaptop();
});

afterEach(() => {
  resetLaptopConfigForTest();
  resetConfigSyncForTest();
  delete (window as unknown as { __KIOSK_CONFIG__?: unknown }).__KIOSK_CONFIG__;
});

describe('laptop config through the edge', () => {
  it('seeds the edge from this browser when it has no config yet, unstamped', async () => {
    writeAppearance({ flash_ms: 500 });                // a customized browser
    api.getEdgeConfig.mockResolvedValue({ doc: null, version: 0, changed_at: null });
    await pollEdgeConfig();
    expect(api.putEdgeConfig).toHaveBeenCalledTimes(1);
    const body = api.putEdgeConfig.mock.calls[0][0];
    expect(body.seed).toBe(true);
    expect(body.doc).toEqual(collectConfig());
    expect(readConfigState().applied_version).toBe(1);
  });

  it('applies a new version from the edge, whole, and not the same version twice', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    expect(readAppearance().flash_ms).toBe(900);
    expect(readConfigState().applied_version).toBe(5);
    expect(JSON.stringify(collectConfig().android_rfid)).toBe(JSON.stringify(PORTAL_DOC.android_rfid));
    expect(api.putEdgeConfig).not.toHaveBeenCalled();
  });

  it('applying from the edge is never sent back as an edit', async () => {
    writeDevMode(true);                                // customized, so it seeds
    api.getEdgeConfig.mockResolvedValue({ doc: null, version: 0, changed_at: null });
    const stop = startLaptopConfigSync(60_000);
    await vi.waitFor(() => expect(api.putEdgeConfig).toHaveBeenCalledTimes(1));   // the seed
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    expect(readAppearance().flash_ms).toBe(900);
    await new Promise((r) => setTimeout(r, 600));
    expect(api.putEdgeConfig).toHaveBeenCalledTimes(1);
    writeAppearance({ flash_ms: 500 });                          // a real edit is sent
    await vi.waitFor(() => expect(api.putEdgeConfig).toHaveBeenCalledTimes(2));
    stop();
  });

  it('a browser still on the defaults never seeds the edge', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: null, version: 0, changed_at: null });
    await pollEdgeConfig();
    expect(api.putEdgeConfig).not.toHaveBeenCalled();
    expect(readConfigState().applied_version).toBeNull();
    // it takes the edge's copy once another browser or the portal provides it
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 2, changed_at: null });
    await pollEdgeConfig();
    expect(readAppearance().flash_ms).toBe(900);
    expect(api.putEdgeConfig).not.toHaveBeenCalled();
  });

  it('a different document at the version it holds is applied (the edge was reset)', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    api.getEdgeConfig.mockResolvedValue({
      doc: { ...PORTAL_DOC, developer: { dev_mode: true } }, version: 5, changed_at: null,
    });
    await pollEdgeConfig();
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(5);
  });

  it('a later version replaces the stores', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    api.getEdgeConfig.mockResolvedValue({
      doc: { ...PORTAL_DOC, developer: { dev_mode: true } }, version: 6, changed_at: null,
    });
    await pollEdgeConfig();
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(6);
  });

  it('a local edit goes to PUT /edge/config with its base version, whole document', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    const stop = startLaptopConfigSync(60_000);
    await vi.waitFor(() => expect(readConfigState().applied_version).toBe(5));
    api.putEdgeConfig.mockResolvedValue({
      doc: { ...PORTAL_DOC, developer: { dev_mode: true } }, version: 6, changed_at: 'x',
    });
    writeDevMode(true);
    await vi.waitFor(() => expect(api.putEdgeConfig).toHaveBeenCalledTimes(1));
    const body = api.putEdgeConfig.mock.calls[0][0];
    expect(body.base_version).toBe(5);
    expect(body.seed).toBeUndefined();
    expect(body.doc.developer).toEqual({ dev_mode: true });
    expect(JSON.stringify(body.doc.alarm)).toBe(JSON.stringify(PORTAL_DOC.alarm));
    expect(JSON.stringify(body.doc.future_thing)).toBe(JSON.stringify(PORTAL_DOC.future_thing));
    await vi.waitFor(() => expect(readConfigState().applied_version).toBe(6));
    // the web heartbeat path stays inert: nothing marked dirty there
    expect(readConfigState().dirty).toBe(false);
    stop();
  });

  it('merges when another browser changed the config first (409)', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    const other = { ...PORTAL_DOC, appearance: { ...PORTAL_DOC.appearance, flash_ms: 1200 } };
    api.putEdgeConfig
      .mockRejectedValueOnce(new ApiError(409, 'config_changed', {
        code: 'config_changed', doc: other, version: 7, changed_at: 'y',
      }))
      .mockImplementation(({ doc }: { doc: unknown }) =>
        Promise.resolve({ doc, version: 8, changed_at: 'z' }));
    const stop = startLaptopConfigSync(60_000);
    writeDevMode(true);
    await vi.waitFor(() => expect(api.putEdgeConfig).toHaveBeenCalledTimes(2));
    const second = api.putEdgeConfig.mock.calls[1][0];
    expect(second.base_version).toBe(7);
    expect(second.doc.developer).toEqual({ dev_mode: true });     // this browser's edit
    expect(second.doc.appearance.flash_ms).toBe(1200);             // the other browser's
    expect(readAppearance().flash_ms).toBe(1200);
    await vi.waitFor(() => expect(readConfigState().applied_version).toBe(8));
    stop();
  });

  it('a failed PUT stays pending and goes on the next poll', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    api.putEdgeConfig.mockRejectedValueOnce(new ApiError(0, 'network'));
    const stop = startLaptopConfigSync(60_000);
    writeDevMode(true);
    await vi.waitFor(() => expect(api.putEdgeConfig).toHaveBeenCalledTimes(1));
    const accepted = { doc: { ...PORTAL_DOC, developer: { dev_mode: true } }, version: 6, changed_at: 'x' };
    api.putEdgeConfig.mockResolvedValue(accepted);
    api.getEdgeConfig.mockResolvedValue(accepted);
    await pollEdgeConfig();
    expect(api.putEdgeConfig).toHaveBeenCalledTimes(2);
    expect(api.putEdgeConfig.mock.calls[1][0].doc.developer).toEqual({ dev_mode: true });
    expect(readDevMode()).toBe(true);                               // never rolled back
    stop();
  });

  it('a poll answer that raced a PUT is not applied', async () => {
    api.getEdgeConfig.mockResolvedValue({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await pollEdgeConfig();
    let release!: (v: unknown) => void;
    api.getEdgeConfig.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const polling = pollEdgeConfig();                 // a GET in flight...
    api.putEdgeConfig.mockResolvedValue({
      doc: { ...PORTAL_DOC, developer: { dev_mode: true } }, version: 6, changed_at: 'x',
    });
    const stop = startLaptopConfigSync(60_000);
    writeDevMode(true);                               // ...while an edit is accepted
    await vi.waitFor(() => expect(readConfigState().applied_version).toBe(6));
    release({ doc: PORTAL_DOC, version: 5, changed_at: null });
    await polling;
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(6);
    stop();
  });

  it('a heartbeat reply still updates the scan type on a laptop, and nothing else', () => {
    writeKioskSetup({
      initiativeId: 'm', initiativeName: 'M', siteId: 's', siteName: 'S', siteRole: 'source',
      scanStatus: 'a', scanLabel: 'A',
    });
    const out = handleConfigReply({
      device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null,
      server_time: new Date().toISOString(), config_version: 3,
      config: { ...PORTAL_DOC, developer: { dev_mode: true } },
      scan_status: 'b', scan_status_label: 'B',
    } as never, null);
    expect(out).toEqual({ rebeat: false });
    expect(readKioskSetup()).toMatchObject({ scanStatus: 'b', scanLabel: 'B' });
    expect(readDevMode()).toBe(false);
    expect(readConfigState().applied_version).toBeNull();
  });

  it('is inert on a web kiosk', async () => {
    delete (window as unknown as { __KIOSK_CONFIG__?: unknown }).__KIOSK_CONFIG__;
    const stop = startLaptopConfigSync(60_000);
    writeDevMode(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.getEdgeConfig).not.toHaveBeenCalled();
    expect(api.putEdgeConfig).not.toHaveBeenCalled();
    stop();
  });
});
