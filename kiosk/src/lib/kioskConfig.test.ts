// @vitest-environment jsdom
/**
 * Settings sync with the portal: building and applying the config
 * document, local-change tracking, and the heartbeat integration (with
 * the API mocked at `./api`).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  heartbeatRequest: vi.fn(),
  uploadKioskSound: vi.fn(),
  downloadKioskSound: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, ...api };
});

import { ApiError } from './api';
import { readAppearance, writeAppearance } from './appearance';
import { readCheckpoint, writeCheckpoint } from './checkpointSettings';
import { readDevMode, writeDevMode } from './devMode';
import { startHeartbeat } from './heartbeat';
import {
  REPORT_INTERVAL_MS, applyConfig, collectConfig, configBeatFields, handleConfigReply,
  installConfigTracking, ownedSectionsAreDefault, readConfigState, resetConfigSyncForTest,
} from './kioskConfig';
import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { closeDb, putRows } from './localDb';
import {
  DEFAULT_SOUND_SETTINGS, readSoundSettings, resetSoundAudioForTest, writeSoundSettings,
} from './sound';

const DEFAULT_DOC = {
  schema: 1,
  appearance: {
    good_scan: { h: 150, s: 60, l: 45 },
    not_found_scan: { h: 0, s: 70, l: 50 },
    duplicate_scan: { h: 38, s: 92, l: 50 },
    flash_ms: 350,
  },
  sound: {
    good: { kind: 'builtin', id: 'chime' },
    not_found: { kind: 'builtin', id: 'buzz' },
    duplicate: { kind: 'builtin', id: 'double_beep' },
    alarm: { kind: 'siren' },
    volume: 0.8,
  },
  checkpoints: {
    enroll: 'pre_stage',
    container_pack: 'in_container',
    container_unpack: 'un_pack',
    truck_load: 'on_truck',
    truck_unload: 'received',
  },
  developer: { dev_mode: false },
};

/** A portal document carrying every section, including ones a web kiosk
 *  doesn't use, plus a section no app knows yet. */
const PORTAL_DOC = {
  ...DEFAULT_DOC,
  appearance: { ...DEFAULT_DOC.appearance, good_scan: { h: 200, s: 50, l: 40 }, flash_ms: 900 },
  sound: { ...DEFAULT_DOC.sound, not_found: { kind: 'builtin', id: 'bonk' }, volume: 0.5 },
  checkpoints: { ...DEFAULT_DOC.checkpoints, truck_load: 'loaded' },
  developer: { dev_mode: true },
  alarm: { mode: 'timed', timed_seconds: 42 },
  android_rfid: { power: 270, session: 'S1', nested: { a: [1, 2, { b: null }] } },
  ios: { camera_position: 'front' },
  future_thing: { anything: 'goes', n: 1.5 },
};

const reply = (extra: Record<string, unknown> = {}) => ({
  device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null,
  server_time: new Date(Date.now()).toISOString(), config_version: 0, config: null,
  scan_status: null, scan_status_label: null, ...extra,
});

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  resetConfigSyncForTest();
  resetSoundAudioForTest();
  api.heartbeatRequest.mockReset();
  api.heartbeatRequest.mockResolvedValue(reply());
  api.uploadKioskSound.mockReset();
  let n = 0;
  api.uploadKioskSound.mockImplementation((file: Blob, name: string) => {
    n += 1;
    return Promise.resolve({ id: `p${n}`, name, content_type: file.type, size: file.size });
  });
  api.downloadKioskSound.mockReset();
  api.downloadKioskSound.mockRejectedValue(new ApiError(0, 'network'));
  delete (window as unknown as { __KIOSK_CONFIG__?: unknown }).__KIOSK_CONFIG__;
});

afterEach(() => {
  resetConfigSyncForTest();
  vi.useRealTimers();
});

describe('collect and apply', () => {
  it('a fresh kiosk collects the defaults', () => {
    expect(collectConfig()).toEqual(DEFAULT_DOC);
  });

  it('knows a browser nobody customized (unknown keys and key order do not count)', () => {
    expect(ownedSectionsAreDefault(collectConfig())).toBe(true);
    expect(ownedSectionsAreDefault(DEFAULT_DOC)).toBe(true);
    expect(ownedSectionsAreDefault({
      ...DEFAULT_DOC,
      sound: { ...DEFAULT_DOC.sound, good: { id: 'chime', kind: 'builtin' }, extra: 1 },
    })).toBe(true);
    writeCheckpoint('truckLoad', 'loaded');
    expect(ownedSectionsAreDefault(collectConfig())).toBe(false);
    expect(ownedSectionsAreDefault(PORTAL_DOC)).toBe(false);
  });

  it('round-trips a whole document, unknown and other-platform sections byte-for-byte', () => {
    applyConfig(PORTAL_DOC, 3);
    const out = collectConfig();
    expect(out).toEqual(PORTAL_DOC);
    expect(JSON.stringify(out.android_rfid)).toBe(JSON.stringify(PORTAL_DOC.android_rfid));
    expect(JSON.stringify(out.future_thing)).toBe(JSON.stringify(PORTAL_DOC.future_thing));
    expect(readConfigState().applied_version).toBe(3);

    // The stores really hold the values.
    expect(readAppearance().good_scan).toEqual({ h: 200, s: 50, l: 40 });
    expect(readAppearance().flash_ms).toBe(900);
    expect(readSoundSettings().not_found).toEqual({ kind: 'builtin', id: 'bonk' });
    expect(readCheckpoint('truckLoad')).toBe('loaded');
    expect(readDevMode()).toBe(true);
  });

  it('local edits overlay the owned sections and keep the rest of the received document', () => {
    applyConfig(PORTAL_DOC, 3);
    writeAppearance({ flash_ms: 500 });
    writeDevMode(false);
    const out = collectConfig();
    expect(out.appearance).toEqual({ ...PORTAL_DOC.appearance, flash_ms: 500 });
    expect(out.developer).toEqual({ dev_mode: false });
    expect(out.alarm).toEqual(PORTAL_DOC.alarm);
    expect(out.ios).toEqual(PORTAL_DOC.ios);
  });

  it('keeps unknown fields inside owned sections', () => {
    applyConfig({ ...PORTAL_DOC, appearance: { ...PORTAL_DOC.appearance, glow: 3 } }, 1);
    expect((collectConfig().appearance as Record<string, unknown>).glow).toBe(3);
  });

  it('a field it cannot apply keeps its old value; the rest applies; nothing throws', () => {
    writeAppearance({ good_scan: { h: 10, s: 10, l: 10 } });
    writeSoundSettings({ good: { kind: 'builtin', id: 'beep' } });
    writeCheckpoint('enroll', 'tagged');
    writeDevMode(true);
    const bad = {
      schema: 1,
      appearance: { good_scan: { h: 999, s: 'x', l: 1 }, not_found_scan: { h: 5, s: 5, l: 5 }, flash_ms: 'slow' },
      sound: { good: { kind: 'builtin', id: 'trombone' }, alarm: { kind: 'none' }, volume: 'loud',
        duplicate: { kind: 'builtin', id: 'bonk' } },
      checkpoints: { enroll: '', container_pack: 'x'.repeat(101), truck_unload: 'arrived' },
      developer: { dev_mode: 'yes' },
    };
    expect(() => applyConfig(bad, 4)).not.toThrow();
    expect(readAppearance().good_scan).toEqual({ h: 10, s: 10, l: 10 });
    expect(readAppearance().not_found_scan).toEqual({ h: 5, s: 5, l: 5 });
    expect(readAppearance().flash_ms).toBe(350);
    expect(readSoundSettings().good).toEqual({ kind: 'builtin', id: 'beep' });
    expect(readSoundSettings().duplicate).toEqual({ kind: 'builtin', id: 'bonk' });
    expect(readSoundSettings().alarm).toEqual({ kind: 'siren' });
    expect(readSoundSettings().volume).toBe(0.8);
    expect(readCheckpoint('enroll')).toBe('tagged');
    expect(readCheckpoint('containerPack')).toBe('in_container');
    expect(readCheckpoint('truckUnload')).toBe('arrived');
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(4);

    // Sections of the wrong shape, or a document that isn't an object.
    expect(() => applyConfig({ schema: 1, appearance: 'red', sound: [1], developer: null }, 5)).not.toThrow();
    expect(() => applyConfig('nope', 6)).not.toThrow();
    expect(() => applyConfig(null, 7)).not.toThrow();
    expect(readConfigState().applied_version).toBe(5);
  });

  it('flash_ms is clamped by the appearance store, the same as a slider write', () => {
    applyConfig({ ...DEFAULT_DOC, appearance: { ...DEFAULT_DOC.appearance, flash_ms: 50_000 } }, 1);
    expect(readAppearance().flash_ms).toBe(2000);
    applyConfig({ ...DEFAULT_DOC, appearance: { ...DEFAULT_DOC.appearance, flash_ms: 3 } }, 2);
    expect(readAppearance().flash_ms).toBe(100);
  });
});

describe('local change tracking', () => {
  it('applying never marks the config dirty', () => {
    installConfigTracking();
    applyConfig(PORTAL_DOC, 2);
    expect(readConfigState().dirty).toBe(false);
    expect(readConfigState().changed_at).toBeNull();
  });

  it('a local edit marks it dirty, stamped with portal-corrected time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    // The portal's clock is 2 h behind this kiosk's.
    localStorage.setItem('ss.kiosk.configSync', JSON.stringify({ server_offset_ms: -2 * 3600_000 }));
    installConfigTracking();
    writeCheckpoint('enroll', 'tagged');
    const st = readConfigState();
    expect(st.dirty).toBe(true);
    expect(st.changed_at).toBe('2026-10-17T10:00:00.000Z');
  });

  it('every owned store counts', () => {
    installConfigTracking();
    for (const edit of [
      () => writeAppearance({ flash_ms: 400 }),
      () => writeSoundSettings({ volume: 0.3 }),
      () => writeCheckpoint('truckLoad', 'x'),
      () => writeDevMode(true),
    ]) {
      localStorage.removeItem('ss.kiosk.configSync');
      edit();
      expect(readConfigState().dirty).toBe(true);
    }
  });

  it('is inert on a laptop', () => {
    (window as unknown as { __KIOSK_CONFIG__: unknown }).__KIOSK_CONFIG__ = { mode: 'laptop' };
    installConfigTracking();
    writeDevMode(true);
    expect(readConfigState().dirty).toBe(false);
  });
});

describe('beat fields and replies', () => {
  it('reports at first contact unstamped, then not again until dirty or 60 minutes pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    installConfigTracking();

    const first = (await configBeatFields())!;
    expect(first.reported).toBe(true);
    expect(first.fields.config).toEqual(DEFAULT_DOC);
    expect(first.fields.config_changed_at).toBeNull();
    expect(first.fields.config_applied_version).toBeNull();
    handleConfigReply(reply() as never, first);

    const second = (await configBeatFields())!;
    expect(second.reported).toBe(false);
    expect(second.fields).toEqual({ config_applied_version: null });
    handleConfigReply(reply() as never, second);

    writeDevMode(true);
    const dirty = (await configBeatFields())!;
    expect(dirty.reported).toBe(true);
    expect(dirty.fields.config_changed_at).toBe('2026-10-17T12:00:00.000Z');
    expect((dirty.fields.config as Record<string, { dev_mode: boolean }>).developer.dev_mode).toBe(true);
    handleConfigReply(reply() as never, dirty);
    expect(readConfigState().dirty).toBe(false);

    vi.setSystemTime(new Date(Date.now() + REPORT_INTERVAL_MS - 1000));
    expect((await configBeatFields())!.reported).toBe(false);
    vi.setSystemTime(new Date(Date.now() + 2000));
    const hourly = (await configBeatFields())!;
    expect(hourly.reported).toBe(true);
    // The last change's stamp rides along.
    expect(hourly.fields.config_changed_at).toBe('2026-10-17T12:00:00.000Z');
  });

  it('keeps the portal clock offset from server_time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));     // kiosk clock 3 days ahead
    installConfigTracking();
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({ server_time: '2026-10-17T12:00:00Z' }) as never, beat);
    expect(readConfigState().server_offset_ms).toBe(-3 * 86_400_000);
    writeAppearance({ flash_ms: 600 });
    expect(readConfigState().changed_at).toBe('2026-10-17T12:00:00.000Z');
  });

  it('a change made before the portal clock is known waits for it, then goes out corrected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    installConfigTracking();
    writeDevMode(true);
    const held = (await configBeatFields())!;
    expect(held.reported).toBe(false);
    expect(held.awaitingClock).toBe(true);
    const { rebeat } = handleConfigReply(reply({ server_time: '2026-10-17T12:00:00Z' }) as never, held);
    expect(rebeat).toBe(true);
    const next = (await configBeatFields())!;
    expect(next.reported).toBe(true);
    expect(next.fields.config_changed_at).toBe('2026-10-17T12:00:00.000Z');
  });

  it('a received config is applied and acknowledged by version on the next beat', async () => {
    installConfigTracking();
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({ config: PORTAL_DOC, config_version: 7 }) as never, beat);
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(7);
    expect(readConfigState().dirty).toBe(false);
    const next = (await configBeatFields())!;
    expect(next.fields.config_applied_version).toBe(7);
    expect(next.reported).toBe(false);
  });

  it('a config: null reply with a newer version changes nothing (keep beating)', async () => {
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({ config: null, config_version: 9 }) as never, beat);
    expect(readConfigState().applied_version).toBeNull();
  });

  it('a local change made while the beat was in flight is not overwritten', async () => {
    installConfigTracking();
    const beat = (await configBeatFields())!;
    writeCheckpoint('enroll', 'mine');
    handleConfigReply(reply({ config: PORTAL_DOC, config_version: 2 }) as never, beat);
    expect(readCheckpoint('enroll')).toBe('mine');
    expect(readConfigState().dirty).toBe(true);
    expect(readConfigState().applied_version).toBeNull();
  });

  it('a scan type from the portal updates the saved setup when it differs', async () => {
    writeKioskSetup({
      initiativeId: 'i', initiativeName: 'Move', siteId: 's', siteName: 'Site',
      siteRole: 'source', scanStatus: 'on_truck', scanLabel: 'On truck',
    });
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({ scan_status: 'received', scan_status_label: 'Received' }) as never, beat);
    expect(readKioskSetup()).toMatchObject({ scanStatus: 'received', scanLabel: 'Received', siteName: 'Site' });
    // No scan type in the reply leaves it alone.
    handleConfigReply(reply() as never, beat);
    expect(readKioskSetup()?.scanStatus).toBe('received');
  });

  it('local sounds go to the portal and their choices are remapped before the first report', async () => {
    await putRows('sounds', [{
      id: 'local-1', name: 'ding.wav', type: 'audio/wav', size: 4,
      blob: new Blob([new Uint8Array(4)], { type: 'audio/wav' }), created_at: '2026-01-01T00:00:00Z',
    }]);
    writeSoundSettings({ good: { kind: 'upload', id: 'local-1' } });
    installConfigTracking();
    const beat = (await configBeatFields())!;
    expect(api.uploadKioskSound).toHaveBeenCalledTimes(1);
    expect(beat.reported).toBe(true);
    expect((beat.fields.config as { sound: { good: unknown } }).sound.good)
      .toEqual({ kind: 'upload', id: 'p1' });
    // The remap is not a local change: the first report stays unstamped,
    // so a portal edit made before it still wins.
    expect(beat.fields.config_changed_at).toBeNull();
    expect(readConfigState().dirty).toBe(false);
  });

  it('holds the report while a chosen local sound cannot reach the portal', async () => {
    await putRows('sounds', [{
      id: 'local-1', name: 'ding.wav', type: 'audio/wav', size: 4,
      blob: new Blob([new Uint8Array(4)], { type: 'audio/wav' }), created_at: '2026-01-01T00:00:00Z',
    }]);
    writeSoundSettings({ good: { kind: 'upload', id: 'local-1' } });
    api.uploadKioskSound.mockReset();
    api.uploadKioskSound.mockRejectedValue(new ApiError(0, 'network'));
    const beat = (await configBeatFields())!;
    expect(beat.reported).toBe(false);
    expect(beat.fields).toEqual({ config_applied_version: null });
  });

  it('a received config naming a portal sound starts its download; the default plays meanwhile', async () => {
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({
      config: { ...DEFAULT_DOC, sound: { ...DEFAULT_DOC.sound, good: { kind: 'upload', id: 'p42' } } },
      config_version: 1,
    }) as never, beat);
    expect(readSoundSettings().good).toEqual({ kind: 'upload', id: 'p42' });
    await vi.waitFor(() => expect(api.downloadKioskSound).toHaveBeenCalledWith('p42'));
    expect(DEFAULT_SOUND_SETTINGS.good).toEqual({ kind: 'builtin', id: 'chime' });
  });

  it('is inert on a laptop', async () => {
    (window as unknown as { __KIOSK_CONFIG__: unknown }).__KIOSK_CONFIG__ = { mode: 'laptop' };
    expect(await configBeatFields()).toBeNull();
    expect(handleConfigReply(reply({ config: PORTAL_DOC, config_version: 3 }) as never, null))
      .toEqual({ rebeat: false });
    expect(readDevMode()).toBe(false);
  });
});

describe('review fixes', () => {
  it('a reply config that arrives while dirty becomes the base, so the next report carries its sections', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    installConfigTracking();
    writeDevMode(true);                                   // offline edit, no clock yet
    const held = (await configBeatFields())!;
    expect(held.awaitingClock).toBe(true);
    const { rebeat } = handleConfigReply(reply({
      server_time: '2026-10-17T12:00:00Z', config: PORTAL_DOC, config_version: 4,
    }) as never, held);
    expect(rebeat).toBe(true);
    // The stores and the applied version are untouched: the local edit is pending.
    expect(readDevMode()).toBe(true);
    expect(readCheckpoint('truckLoad')).toBe('on_truck');
    expect(readConfigState().applied_version).toBeNull();
    const next = (await configBeatFields())!;
    expect(next.reported).toBe(true);
    const sent = next.fields.config as Record<string, unknown>;
    expect(JSON.stringify(sent.alarm)).toBe(JSON.stringify(PORTAL_DOC.alarm));
    expect(JSON.stringify(sent.ios)).toBe(JSON.stringify(PORTAL_DOC.ios));
    expect(JSON.stringify(sent.android_rfid)).toBe(JSON.stringify(PORTAL_DOC.android_rfid));
    expect(JSON.stringify(sent.future_thing)).toBe(JSON.stringify(PORTAL_DOC.future_thing));
    expect((sent.developer as { dev_mode: boolean }).dev_mode).toBe(true);
    expect((sent.checkpoints as { truck_load: string }).truck_load).toBe('on_truck');
  });

  it('a stale reply from an overlapping beat never rolls back a newer applied config', async () => {
    const a = (await configBeatFields())!;
    const b = (await configBeatFields())!;
    const v3 = { ...PORTAL_DOC, developer: { dev_mode: true } };
    const v2 = { ...PORTAL_DOC, developer: { dev_mode: false }, ios: { camera_position: 'back' } };
    handleConfigReply(reply({ config: v3, config_version: 3 }) as never, b);
    expect(readConfigState().applied_version).toBe(3);
    handleConfigReply(reply({ config: v2, config_version: 2 }) as never, a);
    expect(readDevMode()).toBe(true);
    expect(readConfigState().applied_version).toBe(3);
    expect(collectConfig().ios).toEqual(PORTAL_DOC.ios);
    // The same version again is ignored too.
    writeDevMode(false);
    localStorage.setItem('ss.kiosk.configSync', JSON.stringify({ ...readConfigState(), dirty: false }));
    const c = (await configBeatFields())!;
    handleConfigReply(reply({ config: v3, config_version: 3 }) as never, c);
    expect(readDevMode()).toBe(false);
  });

  it('a reply below the version its beat sent is a reset (the row was recreated): applied', async () => {
    installConfigTracking();
    const first = (await configBeatFields())!;
    handleConfigReply(reply({ config: PORTAL_DOC, config_version: 7 }) as never, first);
    expect(readConfigState().applied_version).toBe(7);
    const beat = (await configBeatFields())!;
    expect(beat.fields.config_applied_version).toBe(7);
    // Clear Offline / delete / DB revert: the portal restarted at version 1
    const v1 = { ...PORTAL_DOC, developer: { dev_mode: false } };
    handleConfigReply(reply({ config: v1, config_version: 1 }) as never, beat);
    expect(readDevMode()).toBe(false);
    expect(readConfigState().applied_version).toBe(1);
    expect((await configBeatFields())!.fields.config_applied_version).toBe(1);
  });

  it('a reset reply with no document resets the applied version and reports on the next beat', async () => {
    installConfigTracking();
    const first = (await configBeatFields())!;
    handleConfigReply(reply({ config: PORTAL_DOC, config_version: 7 }) as never, first);
    const beat = (await configBeatFields())!;
    expect(beat.reported).toBe(false);
    handleConfigReply(reply({ config: null, config_version: 0 }) as never, beat);
    expect(readDevMode()).toBe(true);                 // nothing to apply: stores kept
    expect(readConfigState().applied_version).toBe(0);
    const next = (await configBeatFields())!;
    expect(next.reported).toBe(true);
    expect(next.fields.config_applied_version).toBe(0);
  });

  it('a scan type with no label uses its key as the label', async () => {
    writeKioskSetup({
      initiativeId: 'i', initiativeName: 'Move', siteId: 's', siteName: 'Site',
      siteRole: 'source', scanStatus: 'on_truck', scanLabel: 'On truck',
    });
    const beat = (await configBeatFields())!;
    handleConfigReply(reply({ scan_status: 'staged', scan_status_label: null }) as never, beat);
    expect(readKioskSetup()).toMatchObject({ scanStatus: 'staged', scanLabel: 'staged' });
  });
});

describe('through the heartbeat', () => {
  it('the first beat reports, later beats only acknowledge, a dirty beat reports again', async () => {
    // Only the beat interval is faked: IndexedDB needs real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.heartbeatRequest.mockResolvedValueOnce(reply({ config: PORTAL_DOC, config_version: 1 }));
    const handle = startHeartbeat(vi.fn(), 1000, { method: 'password' });
    await vi.waitFor(() => expect(readDevMode()).toBe(true));
    const first = api.heartbeatRequest.mock.calls[0][0];
    expect(first.sign_in).toBe(true);
    expect(first.config).toEqual(DEFAULT_DOC);
    expect(first.config_changed_at).toBeNull();
    expect(first.config_applied_version).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(api.heartbeatRequest).toHaveBeenCalledTimes(2));
    const second = api.heartbeatRequest.mock.calls[1][0];
    expect(second.config).toBeUndefined();
    expect(second.config_changed_at).toBeUndefined();
    expect(second.config_applied_version).toBe(1);

    writeDevMode(false);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(api.heartbeatRequest).toHaveBeenCalledTimes(3));
    const third = api.heartbeatRequest.mock.calls[2][0];
    expect((third.config as { developer: unknown }).developer).toEqual({ dev_mode: false });
    expect(typeof third.config_changed_at).toBe('string');
    expect((third.config as Record<string, unknown>).android_rfid).toEqual(PORTAL_DOC.android_rfid);
    handle.stop();
  });

  it('a laptop beat carries no config fields', async () => {
    (window as unknown as { __KIOSK_CONFIG__: unknown }).__KIOSK_CONFIG__ = { mode: 'laptop' };
    const handle = startHeartbeat(vi.fn(), 60_000);
    await vi.waitFor(() => expect(api.heartbeatRequest).toHaveBeenCalledTimes(1));
    const body = api.heartbeatRequest.mock.calls[0][0];
    expect('config' in body).toBe(false);
    expect('config_applied_version' in body).toBe(false);
    handle.stop();
  });
});
