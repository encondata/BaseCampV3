// @vitest-environment jsdom
/**
 * Scan sounds, against a fake Web Audio API: jsdom has no `AudioContext`
 * and never plays an `<audio>` element, so the built-in tones are checked
 * by the oscillators they start rather than by anything audible.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  uploadKioskSound: vi.fn(),
  downloadKioskSound: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, ...api };
});

import { ApiError } from './api';
import { closeDb, count, getAll, putRows } from './localDb';
import {
  BUILTIN_SOUNDS, DEFAULT_SOUND_SETTINGS, MAX_SOUND_BYTES, addUploadedSound, ensureSoundCached,
  listUploadedSounds, localOnlyChoiceIds, playScanSound, readSoundSettings, removeUploadedSound,
  resetSoundAudioForTest, soundBlocked, soundSettled, startAlarmSound, startSiren,
  subscribeSoundSettings, uploadLocalSounds, writeSoundSettings,
} from './sound';

interface Started { type: string; freq: number }

const started: Started[] = [];
let stopped = 0;
let contexts = 0;

class FakeParam {
  constructor(public value: number) {}
  setValueAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this; }
}

class FakeNode {
  connect(target: unknown) { return target; }
  disconnect() { /* noop */ }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  started = false;
  start() { this.started = true; started.push({ type: this.type, freq: this.frequency.value }); }
  stop() { stopped += 1; }
}

class FakeGain extends FakeNode { gain = new FakeParam(1); }

class FakeAudioContext {
  state = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  resume = vi.fn(() => { this.state = 'running'; return Promise.resolve(); });
  constructor() { contexts += 1; }
  createOscillator() { return new FakeOscillator(); }
  createGain() { return new FakeGain(); }
}

function installAudio() {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
}

const wav = (bytes = 8) =>
  new File([new Uint8Array(bytes)], 'ding.wav', { type: 'audio/wav' });

let portalIds = 0;

beforeEach(() => {
  portalIds = 0;
  api.uploadKioskSound.mockReset();
  api.uploadKioskSound.mockImplementation((file: Blob, name: string) => {
    portalIds += 1;
    return Promise.resolve({ id: `p${portalIds}`, name, content_type: file.type, size: file.size });
  });
  api.downloadKioskSound.mockReset();
  api.downloadKioskSound.mockRejectedValue(new ApiError(0, 'network'));
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  resetSoundAudioForTest();
  started.length = 0;
  stopped = 0;
  contexts = 0;
  installAudio();
});

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

it('defaults to a chime, a buzz, and a double beep for a repeat scan', () => {
  expect(readSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  expect(DEFAULT_SOUND_SETTINGS).toEqual({
    good: { kind: 'builtin', id: 'chime' },
    not_found: { kind: 'builtin', id: 'buzz' },
    duplicate: { kind: 'builtin', id: 'double_beep' },
    alarm: { kind: 'siren' },
    volume: 0.8,
  });
  expect(BUILTIN_SOUNDS.map((s) => s.id))
    .toEqual(['chime', 'beep', 'double_beep', 'buzz', 'bonk']);
});

it('a stored file written before the duplicate sound reads back with the default', () => {
  localStorage.setItem('ss.kiosk.sound', JSON.stringify({
    good: { kind: 'builtin', id: 'beep' }, not_found: { kind: 'none' }, volume: 0.5,
  }));
  expect(readSoundSettings()).toEqual({
    good: { kind: 'builtin', id: 'beep' },
    not_found: { kind: 'none' },
    duplicate: DEFAULT_SOUND_SETTINGS.duplicate,
    alarm: { kind: 'siren' },
    volume: 0.5,
  });

  // Writing anything forward persists the new key too.
  writeSoundSettings({ volume: 0.6 });
  expect(JSON.parse(localStorage.getItem('ss.kiosk.sound')!).duplicate)
    .toEqual(DEFAULT_SOUND_SETTINGS.duplicate);
});

it('persists a choice and notifies subscribers', () => {
  let calls = 0;
  const off = subscribeSoundSettings(() => { calls += 1; });
  expect(writeSoundSettings({ good: { kind: 'builtin', id: 'beep' } })).toBe(true);
  expect(calls).toBe(1);
  expect(readSoundSettings()).toEqual({
    ...DEFAULT_SOUND_SETTINGS, good: { kind: 'builtin', id: 'beep' },
  });
  expect(JSON.parse(localStorage.getItem('ss.kiosk.sound')!).good)
    .toEqual({ kind: 'builtin', id: 'beep' });
  off();
});

it('falls back to the defaults for malformed or unknown stored settings', () => {
  localStorage.setItem('ss.kiosk.sound', '{oops');
  expect(readSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  // An unknown built-in falls back; an out-of-range volume is clamped
  // (the same rule as the Appearance tab's flash duration).
  localStorage.setItem('ss.kiosk.sound', JSON.stringify({
    good: { kind: 'builtin', id: 'trombone' }, volume: 9,
  }));
  expect(readSoundSettings()).toEqual({ ...DEFAULT_SOUND_SETTINGS, volume: 1 });
  localStorage.setItem('ss.kiosk.sound', JSON.stringify({ volume: 'loud' }));
  expect(readSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
});

it('plays the chosen built-in tone on each scan outcome', () => {
  playScanSound('good');
  expect(started.length).toBeGreaterThan(0);
  expect(started[0].type).toBe('sine');              // chime, two rising notes
  expect(started.length).toBe(2);
  expect(started[1].freq).toBeGreaterThan(started[0].freq);
  expect(contexts).toBe(1);

  started.length = 0;
  playScanSound('not_found');
  expect(started).toEqual([{ type: 'sawtooth', freq: 150 }]);   // buzz
  expect(contexts).toBe(1);                                     // one shared context

  // A repeat scan is its own outcome, and sounds like neither.
  started.length = 0;
  playScanSound('duplicate');
  expect(started).toEqual([                                     // double beep
    { type: 'square', freq: 880 }, { type: 'square', freq: 880 },
  ]);
  expect(contexts).toBe(1);
});

it('plays nothing when the choice is None', () => {
  writeSoundSettings({
    good: { kind: 'none' }, not_found: { kind: 'none' }, duplicate: { kind: 'none' },
  });
  playScanSound('good');
  playScanSound('not_found');
  playScanSound('duplicate');
  expect(started).toEqual([]);
});

it('never throws when the browser has no audio API at all', () => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  resetSoundAudioForTest();
  expect(() => playScanSound('good')).not.toThrow();
  expect(() => playScanSound('not_found')).not.toThrow();
  expect(started).toEqual([]);
});

it('stores an uploaded sound and lists it', async () => {
  const added = await addUploadedSound(wav());
  expect(added.name).toBe('ding.wav');
  expect(added.id).toBeTruthy();

  const rows = await listUploadedSounds();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: added.id, name: 'ding.wav', type: 'audio/wav', size: 8 });
  expect(await count('sounds')).toBe(1);
});

it('rejects a file that is too large or is not audio', async () => {
  await expect(addUploadedSound(wav(MAX_SOUND_BYTES + 1))).rejects.toThrow('too_large');
  await expect(addUploadedSound(
    new File(['nope'], 'notes.txt', { type: 'text/plain' }),
  )).rejects.toThrow('not_audio');
  expect(await listUploadedSounds()).toEqual([]);
});

it('removing an upload drops the row and resets any choice that used it', async () => {
  const { id } = await addUploadedSound(wav());
  writeSoundSettings({
    good: { kind: 'upload', id },
    not_found: { kind: 'builtin', id: 'bonk' },
    duplicate: { kind: 'upload', id },
  });

  await removeUploadedSound(id);

  expect(await listUploadedSounds()).toEqual([]);
  expect(readSoundSettings().good).toEqual({ kind: 'none' });
  expect(readSoundSettings().duplicate).toEqual({ kind: 'none' });
  expect(readSoundSettings().not_found).toEqual({ kind: 'builtin', id: 'bonk' });
});

it('a choice naming a sound this kiosk lacks plays the slot default and never throws', async () => {
  writeSoundSettings({ good: { kind: 'upload', id: 'gone' } });
  expect(() => playScanSound('good')).not.toThrow();
  await vi.waitFor(() => expect(started.length).toBe(2));
  expect(started[0].type).toBe('sine');                      // the default chime
  await vi.waitFor(() => expect(api.downloadKioskSound).toHaveBeenCalledWith('gone'));
});

it('uploads go to the portal first and are kept under the portal id', async () => {
  const added = await addUploadedSound(wav());
  expect(api.uploadKioskSound).toHaveBeenCalledTimes(1);
  expect(api.uploadKioskSound.mock.calls[0][1]).toBe('ding.wav');
  expect(api.uploadKioskSound.mock.calls[0][2]).toMatch(/^kiosk-web-/);
  expect(added.id).toBe('p1');
  const rows = await getAll<{ id: string; portal?: boolean }>('sounds');
  expect(rows).toEqual([expect.objectContaining({ id: 'p1', portal: true })]);
});

it('an upload the portal cannot take stores nothing locally', async () => {
  api.uploadKioskSound.mockRejectedValueOnce(new ApiError(0, 'network'));
  await expect(addUploadedSound(wav())).rejects.toThrow('upload_failed');
  api.uploadKioskSound.mockRejectedValueOnce(new ApiError(413, 'file_too_large'));
  await expect(addUploadedSound(wav())).rejects.toThrow('too_large');
  api.uploadKioskSound.mockRejectedValueOnce(new ApiError(422, 'empty_file'));
  await expect(addUploadedSound(wav())).rejects.toThrow('not_audio');
  expect(await count('sounds')).toBe(0);
});

const legacyRow = (id: string) => ({
  id, name: `${id}.wav`, type: 'audio/wav', size: 8,
  blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), created_at: '2026-01-01T00:00:00Z',
});

it('local-only uploads move to the portal and every choice is remapped', async () => {
  await putRows('sounds', [legacyRow('local-a'), legacyRow('local-b')]);
  writeSoundSettings({
    good: { kind: 'upload', id: 'local-a' },
    duplicate: { kind: 'upload', id: 'local-a' },
    alarm: { kind: 'upload', id: 'local-b' },
  });
  expect(await localOnlyChoiceIds()).toEqual(['local-a', 'local-a', 'local-b']);

  expect(await uploadLocalSounds()).toBe(true);

  const ids = (await getAll<{ id: string; portal?: boolean }>('sounds')).map((r) => [r.id, r.portal]);
  expect(ids.sort()).toEqual([['p1', true], ['p2', true]]);
  const s = readSoundSettings();
  const byName = new Map(api.uploadKioskSound.mock.calls.map((c, i) => [c[1], `p${i + 1}`]));
  expect(s.good).toEqual({ kind: 'upload', id: byName.get('local-a.wav') });
  expect(s.duplicate).toEqual({ kind: 'upload', id: byName.get('local-a.wav') });
  expect(s.alarm).toEqual({ kind: 'upload', id: byName.get('local-b.wav') });
  expect(await localOnlyChoiceIds()).toEqual([]);

  // Portal rows are never uploaded again.
  expect(await uploadLocalSounds()).toBe(true);
  expect(api.uploadKioskSound).toHaveBeenCalledTimes(2);
});

it('a local upload that cannot reach the portal yet keeps its choice and reports false', async () => {
  await putRows('sounds', [legacyRow('local-a')]);
  writeSoundSettings({ good: { kind: 'upload', id: 'local-a' } });
  api.uploadKioskSound.mockRejectedValueOnce(new ApiError(0, 'network'));
  expect(await uploadLocalSounds()).toBe(false);
  expect(readSoundSettings().good).toEqual({ kind: 'upload', id: 'local-a' });
  expect(await localOnlyChoiceIds()).toEqual(['local-a']);
});

it('a local upload the portal refuses is dropped and its slots go back to their defaults', async () => {
  await putRows('sounds', [legacyRow('local-a')]);
  writeSoundSettings({ not_found: { kind: 'upload', id: 'local-a' }, alarm: { kind: 'upload', id: 'local-a' } });
  api.uploadKioskSound.mockRejectedValueOnce(new ApiError(422, 'not_audio'));
  expect(await uploadLocalSounds()).toBe(true);
  expect(readSoundSettings().not_found).toEqual(DEFAULT_SOUND_SETTINGS.not_found);
  expect(readSoundSettings().alarm).toEqual({ kind: 'siren' });
  expect(await count('sounds')).toBe(0);
});

it('a portal sound downloads once, is cached, and the slot plays the default until then', async () => {
  const played: string[] = [];
  const realAudio = globalThis.Audio;
  const realUrl = URL.createObjectURL;
  (globalThis as unknown as { Audio: unknown }).Audio = class {
    volume = 1;
    constructor(url: string) { played.push(url); }
    play() { return Promise.resolve(); }
  };
  URL.createObjectURL = () => 'blob:portal';
  let finish: (b: Blob) => void = () => undefined;
  api.downloadKioskSound.mockReset();
  api.downloadKioskSound.mockImplementation(() => new Promise<Blob>((done) => { finish = done; }));
  try {
    writeSoundSettings({ good: { kind: 'upload', id: 'p9' } });
    playScanSound('good');
    await vi.waitFor(() => expect(api.downloadKioskSound).toHaveBeenCalledWith('p9'));
    expect(started.map((t) => t.type)).toEqual(['sine', 'sine']);     // default chime
    expect(played).toEqual([]);

    playScanSound('good');                                            // still downloading
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(api.downloadKioskSound).toHaveBeenCalledTimes(1);          // single-flight

    finish(new Blob([new Uint8Array(4)], { type: 'audio/mpeg' }));
    await vi.waitFor(async () => expect(await count('sounds')).toBe(1));
    expect(await ensureSoundCached('p9')).toBe(true);

    started.length = 0;
    playScanSound('good');
    await vi.waitFor(() => expect(played).toEqual(['blob:portal']));
    expect(started).toEqual([]);
    expect(api.downloadKioskSound).toHaveBeenCalledTimes(1);
  } finally {
    (globalThis as unknown as { Audio: unknown }).Audio = realAudio;
    URL.createObjectURL = realUrl;
  }
});

it('a missing uploaded alarm sound sounds the siren while it downloads', async () => {
  const stop = startAlarmSound({ kind: 'upload', id: 'p7' });
  await vi.waitFor(() => expect(started.map((s) => s.type).sort()).toEqual(['sawtooth', 'square']));
  stop();
  expect(stopped).toBe(2);
});

it('a failed download is not retried until the retry window passes', async () => {
  expect(await ensureSoundCached('p5')).toBe(false);
  expect(await ensureSoundCached('p5')).toBe(false);
  expect(api.downloadKioskSound).toHaveBeenCalledTimes(1);
});

it('the siren starts oscillators at the given volume and its stop function stops them', () => {
  const stop = startSiren(0.6);
  expect(started.length).toBeGreaterThan(0);
  expect(stopped).toBe(0);
  stop();
  expect(stopped).toBe(started.length);
  stop(); // a second stop is harmless
  expect(stopped).toBe(started.length);
});

it('the siren never throws: no audio API, or a context that fails mid-build', () => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  resetSoundAudioForTest();
  let stop: () => void = () => undefined;
  expect(() => { stop = startSiren(1); }).not.toThrow();
  expect(() => stop()).not.toThrow();
  expect(soundBlocked()).toBe(false);

  installAudio();
  resetSoundAudioForTest();
  const spy = vi.spyOn(FakeAudioContext.prototype, 'createGain').mockImplementation(() => {
    throw new Error('boom');
  });
  try {
    expect(() => { stop = startSiren(1); }).not.toThrow();
    expect(() => stop()).not.toThrow();
  } finally {
    spy.mockRestore();
  }
});

it('soundBlocked is true while the context stays suspended after resume()', () => {
  const blocking = class extends FakeAudioContext {
    resume = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = blocking;
  resetSoundAudioForTest();
  const stop = startSiren(1);
  expect(soundBlocked()).toBe(true);
  stop();

  installAudio();
  resetSoundAudioForTest();
  startSiren(1)();
  expect(soundBlocked()).toBe(false);
});

it('soundSettled waits for the pending resume(), then soundBlocked reads the settled state', async () => {
  let finish: () => void = () => undefined;
  const slow = class extends FakeAudioContext {
    resume = vi.fn(() => new Promise<void>((done) => {
      finish = () => { this.state = 'running'; done(); };
    }));
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = slow;
  resetSoundAudioForTest();
  const stop = startSiren(1);
  expect(soundBlocked()).toBe(true);          // resume() still pending
  let settled = false;
  const waiting = soundSettled().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await waiting;
  expect(soundBlocked()).toBe(false);
  stop();
});

it('soundSettled resolves at once with no context or a rejected resume()', async () => {
  resetSoundAudioForTest();
  await soundSettled();                       // nothing has tried to play
  const blocking = class extends FakeAudioContext {
    resume = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = blocking;
  resetSoundAudioForTest();
  startSiren(1)();
  await soundSettled();
  expect(soundBlocked()).toBe(true);
});

it('the alarm sound is stored, falls back to the siren, and never reads back as none', () => {
  writeSoundSettings({ alarm: { kind: 'builtin', id: 'beep' } });
  expect(readSoundSettings().alarm).toEqual({ kind: 'builtin', id: 'beep' });
  localStorage.setItem('ss.kiosk.sound', JSON.stringify({ alarm: { kind: 'none' } }));
  expect(readSoundSettings().alarm).toEqual({ kind: 'siren' });
  localStorage.setItem('ss.kiosk.sound', JSON.stringify({ alarm: { kind: 'builtin', id: 'nope' } }));
  expect(readSoundSettings().alarm).toEqual({ kind: 'siren' });
});

it('removing the upload the alarm uses puts the alarm back on the siren', async () => {
  const { id } = await addUploadedSound(wav());
  writeSoundSettings({ alarm: { kind: 'upload', id } });
  await removeUploadedSound(id);
  expect(readSoundSettings().alarm).toEqual({ kind: 'siren' });
});

it('the alarm sound defaults to the siren', () => {
  const stop = startAlarmSound();
  // the siren is a sawtooth tone driven by a square LFO
  expect(started.map((s) => s.type).sort()).toEqual(['sawtooth', 'square']);
  stop();
  expect(stopped).toBe(2);
});

it('a built-in alarm sound repeats until stopped', () => {
  vi.useFakeTimers();
  try {
    writeSoundSettings({ alarm: { kind: 'builtin', id: 'beep' } });
    const stop = startAlarmSound();
    expect(started).toHaveLength(1);
    vi.advanceTimersByTime(470); // 120 ms beep + 350 ms gap
    expect(started).toHaveLength(2);
    vi.advanceTimersByTime(470 * 3);
    expect(started).toHaveLength(5);
    stop();
    stop(); // a second stop is harmless
    vi.advanceTimersByTime(5000);
    expect(started).toHaveLength(5);
  } finally {
    vi.useRealTimers();
  }
});

it('an uploaded alarm sound plays on loop and pauses on stop', async () => {
  const played: { loop: boolean; paused: boolean }[] = [];
  class FakeAudio {
    loop = false;
    volume = 1;
    paused = false;
    constructor() { played.push(this); }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const realAudio = globalThis.Audio;
  const realUrl = URL.createObjectURL;
  (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
  URL.createObjectURL = () => 'blob:alarm';
  try {
    const { id } = await addUploadedSound(wav());
    const stop = startAlarmSound({ kind: 'upload', id });
    await vi.waitFor(() => expect(played).toHaveLength(1));
    expect(played[0].loop).toBe(true);
    stop();
    expect(played[0].paused).toBe(true);
  } finally {
    (globalThis as unknown as { Audio: unknown }).Audio = realAudio;
    URL.createObjectURL = realUrl;
  }
});

it('stopping an uploaded alarm sound before it loads never starts it', async () => {
  const played: unknown[] = [];
  const realAudio = globalThis.Audio;
  const realUrl = URL.createObjectURL;
  (globalThis as unknown as { Audio: unknown }).Audio = class {
    constructor() { played.push(this); }
    play() { return Promise.resolve(); }
    pause() { /* noop */ }
  };
  URL.createObjectURL = () => 'blob:alarm';
  try {
    const { id } = await addUploadedSound(wav());
    startAlarmSound({ kind: 'upload', id })();
    await new Promise((r) => setTimeout(r, 20));
    expect(played).toHaveLength(0);
  } finally {
    (globalThis as unknown as { Audio: unknown }).Audio = realAudio;
    URL.createObjectURL = realUrl;
  }
});
