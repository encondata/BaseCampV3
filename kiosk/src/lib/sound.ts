/**
 * Scan sounds — what this kiosk plays when a scan matches, when it
 * matches nothing, and when it changed nothing (an asset already in this
 * container, a container already on this truck), alongside the
 * Appearance tab's three flashes.
 *
 * Like the flash colors, the choice is kiosk-local (localStorage
 * `ss.kiosk.sound`, the same store/hook idiom as `devMode.ts` and
 * `appearance.ts`): a kiosk on a loud dock needs a different sound from
 * one in a quiet office, and the sound belongs to the screen rather
 * than to whoever is signed in.
 *
 * Two kinds of sound:
 *
 *  - **Built-ins** are synthesized with the Web Audio API rather than
 *    shipped as files — a handful of oscillator notes weighs nothing,
 *    survives an offline kiosk with no cache, and can't 404.
 *  - **Uploads** are the operator's own files, stored whole (blob and
 *    all) in IndexedDB `sounds` (localDb v3) and played through an
 *    `HTMLAudioElement` over an object URL. They never leave the kiosk,
 *    and "Clear local data" deliberately leaves them alone.
 *
 * Nothing here ever throws at a caller: a scan must be recorded whether
 * or not the browser felt like making a noise, so every play path is
 * wrapped and a failure is simply silence.
 *
 * Autoplay policy: the first play happens after a user gesture (a scan
 * is a keypress), so the lazily created `AudioContext` is allowed —
 * `resume()` is called anyway for the browsers that still start it
 * suspended.
 */

import { useSyncExternalStore } from 'react';

import { uuid } from './identity';
import { deleteRows, getAll, putRows } from './localDb';

const KEY = 'ss.kiosk.sound';

export type BuiltinSoundId = 'chime' | 'beep' | 'double_beep' | 'buzz' | 'bonk';

export type SoundChoice =
  | { kind: 'none' }
  | { kind: 'builtin'; id: BuiltinSoundId }
  | { kind: 'upload'; id: string };

export interface SoundSettings {
  good: SoundChoice;
  not_found: SoundChoice;
  /** A scan that changed nothing — a repeat. */
  duplicate: SoundChoice;
  /** 0–1, applied to built-ins (gain) and uploads (`audio.volume`) alike. */
  volume: number;
}

export const BUILTIN_SOUNDS: { id: BuiltinSoundId; label: string }[] = [
  { id: 'chime', label: 'Chime' },
  { id: 'beep', label: 'Beep' },
  { id: 'double_beep', label: 'Double beep' },
  { id: 'buzz', label: 'Buzz' },
  { id: 'bonk', label: 'Bonk' },
];

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  good: { kind: 'builtin', id: 'chime' },
  not_found: { kind: 'builtin', id: 'buzz' },
  // The double beep, of the five built-ins: two flat notes on one pitch
  // are neither the chime's rising pair nor the buzz, and "that came
  // through twice" is exactly what a repeat scan means.
  duplicate: { kind: 'builtin', id: 'double_beep' },
  volume: 0.8,
};

/** Uploads are held in IndexedDB, so the cap is about this kiosk's disk
 *  and about how long a scan sound can sensibly be — not about a
 *  network. 2 MB is a generous few seconds of MP3. */
export const MAX_SOUND_BYTES = 2 * 1024 * 1024;

type Listener = () => void;

const listeners = new Set<Listener>();

const BUILTIN_IDS = new Set<string>(BUILTIN_SOUNDS.map((s) => s.id));

function isChoice(value: unknown): value is SoundChoice {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { kind?: unknown; id?: unknown };
  if (v.kind === 'none') return true;
  if (v.kind === 'builtin') return typeof v.id === 'string' && BUILTIN_IDS.has(v.id);
  if (v.kind === 'upload') return typeof v.id === 'string' && v.id.length > 0;
  return false;
}

function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SOUND_SETTINGS.volume;
  return Math.min(1, Math.max(0, value));
}

// Same referentially-stable-snapshot trick as `appearance.ts`:
// useSyncExternalStore re-renders forever without it.
let cachedRaw: string | null | undefined;
let cached: SoundSettings = DEFAULT_SOUND_SETTINGS;

function read(): SoundSettings {
  let stored: string | null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
  if (stored === cachedRaw) return cached;
  cachedRaw = stored;
  cached = DEFAULT_SOUND_SETTINGS;
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      // Each field falls back on its own, so a stored file written by an
      // older (or newer) kiosk still yields usable settings.
      cached = {
        good: isChoice(parsed?.good) ? parsed.good : DEFAULT_SOUND_SETTINGS.good,
        not_found: isChoice(parsed?.not_found)
          ? parsed.not_found : DEFAULT_SOUND_SETTINGS.not_found,
        duplicate: isChoice(parsed?.duplicate)
          ? parsed.duplicate : DEFAULT_SOUND_SETTINGS.duplicate,
        volume: clampVolume(parsed?.volume),
      };
    } catch {
      /* malformed stored JSON reads as the defaults */
    }
  }
  return cached;
}

export function readSoundSettings(): SoundSettings {
  return read();
}

/** Merges `patch` over the stored settings and notifies subscribers;
 *  false when storage refuses (private window, full store). */
export function writeSoundSettings(patch: Partial<SoundSettings>): boolean {
  const next: SoundSettings = { ...read(), ...patch };
  next.volume = clampVolume(next.volume);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeSoundSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSoundSettings(): [SoundSettings, (patch: Partial<SoundSettings>) => void] {
  const settings = useSyncExternalStore(subscribeSoundSettings, readSoundSettings);
  return [settings, writeSoundSettings];
}

/* ── Uploaded sounds (IndexedDB `sounds`) ──────────────────────────── */

export interface UploadedSound {
  id: string;
  name: string;
  type: string;
  size: number;
  created_at: string;
}

interface SoundRow extends UploadedSound { blob: Blob }

/** Stores `file` on this kiosk. Rejects with `'not_audio'` for anything
 *  that isn't an audio file and `'too_large'` past `MAX_SOUND_BYTES` —
 *  the Sound tab turns both into inline copy. */
export async function addUploadedSound(file: File): Promise<{ id: string; name: string }> {
  if (!file.type || !file.type.startsWith('audio/')) throw new Error('not_audio');
  if (file.size > MAX_SOUND_BYTES) throw new Error('too_large');
  const row: SoundRow = {
    id: uuid(),
    name: file.name,
    type: file.type,
    size: file.size,
    blob: file,
    created_at: new Date().toISOString(),
  };
  await putRows('sounds', [row]);
  return { id: row.id, name: row.name };
}

/** The uploads, oldest first — the blob itself is left out: nothing but
 *  playback needs it, and it is the heavy part of the row. */
export async function listUploadedSounds(): Promise<UploadedSound[]> {
  const rows = await getAll<SoundRow>('sounds');
  return rows
    .map(({ id, name, type, size, created_at }) => ({ id, name, type, size, created_at }))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

/** Deletes an upload, revokes its object URL, and resets any choice that
 *  pointed at it — a scan must never fall silent pointing at a row that
 *  no longer exists. */
export async function removeUploadedSound(id: string): Promise<void> {
  await deleteRows('sounds', [id]);
  const url = objectUrls.get(id);
  if (url) {
    objectUrls.delete(id);
    try { URL.revokeObjectURL(url); } catch { /* no URL API, nothing to revoke */ }
  }
  const settings = read();
  const patch: Partial<SoundSettings> = {};
  if (settings.good.kind === 'upload' && settings.good.id === id) patch.good = { kind: 'none' };
  if (settings.not_found.kind === 'upload' && settings.not_found.id === id) {
    patch.not_found = { kind: 'none' };
  }
  if (settings.duplicate.kind === 'upload' && settings.duplicate.id === id) {
    patch.duplicate = { kind: 'none' };
  }
  if (patch.good || patch.not_found || patch.duplicate) writeSoundSettings(patch);
}

/* ── Playback ──────────────────────────────────────────────────────── */

type AudioCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
const objectUrls = new Map<string, string>();

/** One shared context, created on the first play (never at import time:
 *  a context made before any user gesture starts suspended and some
 *  browsers count it against the page). Null when the browser has no
 *  Web Audio API — every caller treats that as silence. */
function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void Promise.resolve(ctx.resume()).catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

interface Tone {
  type: OscillatorType;
  freq: number;
  /** Offset from the start of the sound, in milliseconds. */
  at: number;
  ms: number;
  /** When set, the note slides there across its length (the bonk). */
  endFreq?: number;
}

const BUILTIN_TONES: Record<BuiltinSoundId, Tone[]> = {
  // Two rising notes, A5 then E6 — the "found it" sound.
  chime: [
    { type: 'sine', freq: 880, at: 0, ms: 90 },
    { type: 'sine', freq: 1318, at: 90, ms: 90 },
  ],
  beep: [{ type: 'square', freq: 880, at: 0, ms: 120 }],
  double_beep: [
    { type: 'square', freq: 880, at: 0, ms: 70 },
    { type: 'square', freq: 880, at: 130, ms: 70 },
  ],
  // Low and rough, so a not-found scan is audibly not a good one.
  buzz: [{ type: 'sawtooth', freq: 150, at: 0, ms: 300 }],
  bonk: [{ type: 'sine', freq: 440, at: 0, ms: 220, endFreq: 160 }],
};

function playBuiltin(id: BuiltinSoundId, volume: number): void {
  const tones = BUILTIN_TONES[id];
  const audio = audioContext();
  if (!tones || !audio) return;
  const now = audio.currentTime;
  for (const tone of tones) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const start = now + tone.at / 1000;
    const end = start + tone.ms / 1000;
    // Exponential ramps can't touch zero, hence the near-silent floor;
    // the short attack and release keep a square wave from clicking.
    const floor = 0.0001;
    const peak = Math.max(floor, clampVolume(volume) * 0.5);
    osc.type = tone.type;
    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.endFreq, end);
    gain.gain.setValueAtTime(floor, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(floor, end);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(end);
  }
}

/** The object URL for an upload, made once per id and kept: a kiosk
 *  scans all day, and minting a URL per scan leaks one per scan. */
async function uploadUrl(id: string): Promise<string | null> {
  const cached_ = objectUrls.get(id);
  if (cached_) return cached_;
  const rows = await getAll<SoundRow>('sounds');
  const row = rows.find((r) => r.id === id);
  if (!row?.blob) return null;
  const url = URL.createObjectURL(row.blob);
  objectUrls.set(id, url);
  return url;
}

async function playUpload(id: string, volume: number): Promise<void> {
  const url = await uploadUrl(id);
  if (!url) return;
  const el = new Audio(url);
  el.volume = clampVolume(volume);
  await el.play();
}

/** Plays one choice at `volume` (the stored volume by default). Never
 *  throws and never rejects — the Sound tab's Play buttons and the scan
 *  path share it. */
export function playSoundChoice(choice: SoundChoice, volume?: number): void {
  const level = volume ?? read().volume;
  try {
    if (choice.kind === 'none') return;
    if (choice.kind === 'builtin') {
      playBuiltin(choice.id, level);
      return;
    }
    void playUpload(choice.id, level).catch(() => undefined);
  } catch {
    /* audio must never break scanning */
  }
}

/** What the Scanning, Containers, and Trucks pages call beside
 *  `flash()` — one case per scan outcome, `duplicate` included: a repeat
 *  scan must not sound like the pack it is not. */
export function playScanSound(which: 'good' | 'not_found' | 'duplicate'): void {
  try {
    const settings = read();
    playSoundChoice(settings[which], settings.volume);
  } catch {
    /* audio must never break scanning */
  }
}

/** Test helper: drops the shared context and the object-URL cache so a
 *  case can swap the audio API out from under the module. */
export function resetSoundAudioForTest(): void {
  ctx = null;
  objectUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch { /* no URL API */ }
  });
  objectUrls.clear();
}
