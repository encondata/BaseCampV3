// @vitest-environment jsdom
/**
 * Scan sounds, against a fake Web Audio API: jsdom has no `AudioContext`
 * and never plays an `<audio>` element, so the built-in tones are checked
 * by the oscillators they start rather than by anything audible.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { closeDb, count } from './localDb';
import {
  BUILTIN_SOUNDS, DEFAULT_SOUND_SETTINGS, MAX_SOUND_BYTES, addUploadedSound, listUploadedSounds,
  playScanSound, readSoundSettings, removeUploadedSound, resetSoundAudioForTest,
  subscribeSoundSettings, writeSoundSettings,
} from './sound';

interface Started { type: string; freq: number }

const started: Started[] = [];
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
  stop() { /* noop */ }
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

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  resetSoundAudioForTest();
  started.length = 0;
  contexts = 0;
  installAudio();
});

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

it('defaults to a chime on a good scan and a buzz on a not-found one', () => {
  expect(readSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS);
  expect(DEFAULT_SOUND_SETTINGS).toEqual({
    good: { kind: 'builtin', id: 'chime' },
    not_found: { kind: 'builtin', id: 'buzz' },
    volume: 0.8,
  });
  expect(BUILTIN_SOUNDS.map((s) => s.id))
    .toEqual(['chime', 'beep', 'double_beep', 'buzz', 'bonk']);
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
});

it('plays nothing when the choice is None', () => {
  writeSoundSettings({ good: { kind: 'none' }, not_found: { kind: 'none' } });
  playScanSound('good');
  playScanSound('not_found');
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
  writeSoundSettings({ good: { kind: 'upload', id }, not_found: { kind: 'builtin', id: 'bonk' } });

  await removeUploadedSound(id);

  expect(await listUploadedSounds()).toEqual([]);
  expect(readSoundSettings().good).toEqual({ kind: 'none' });
  expect(readSoundSettings().not_found).toEqual({ kind: 'builtin', id: 'bonk' });
});

it('a choice pointing at a deleted upload plays nothing and does not throw', async () => {
  writeSoundSettings({ good: { kind: 'upload', id: 'gone' } });
  expect(() => playScanSound('good')).not.toThrow();
  await Promise.resolve();
  expect(started).toEqual([]);
});
