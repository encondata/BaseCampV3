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
 *  - **Uploads** are the operator's own files. Each one goes to the
 *    portal first (`POST /kiosk/sounds`), and its portal id is what a
 *    choice (and so the kiosk config the portal holds) names. The blob is
 *    kept in IndexedDB `sounds` (localDb v3) as the offline copy and
 *    played through an `HTMLAudioElement` over an object URL; "Clear
 *    local data" deliberately leaves them alone. A choice naming a portal
 *    sound this kiosk doesn't hold yet is downloaded
 *    (`GET /kiosk/sounds/{id}`) and cached; until the copy lands, the
 *    slot plays its default. Uploads made before sounds lived on the
 *    portal are moved there by `uploadLocalSounds()`, which kioskConfig.ts
 *    runs before the kiosk's first settings report.
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

import { compareOrdinal } from '@portal/lib/naturalSort';
import { ApiError, downloadKioskSound, uploadKioskSound } from './api';
import { getIdentity } from './identity';
import { deleteRows, getAll, putRows } from './localDb';

const KEY = 'ss.kiosk.sound';

export type BuiltinSoundId = 'chime' | 'beep' | 'double_beep' | 'buzz' | 'bonk';

export type SoundChoice =
  | { kind: 'none' }
  | { kind: 'builtin'; id: BuiltinSoundId }
  | { kind: 'upload'; id: string };

/** The Asset Not Part Of Move alarm's sound: the looping siren, or any
 *  scan sound (built-in or upload) played over and over. Never "none" —
 *  the alarm has to be heard. */
export type AlarmSoundChoice = { kind: 'siren' } | Exclude<SoundChoice, { kind: 'none' }>;

export interface SoundSettings {
  good: SoundChoice;
  not_found: SoundChoice;
  /** A scan that changed nothing — a repeat. */
  duplicate: SoundChoice;
  /** The off-move alarm (laptop RFID Station). */
  alarm: AlarmSoundChoice;
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
  alarm: { kind: 'siren' },
  volume: 0.8,
};

/** The cap is about how long a scan sound can sensibly be: 2 MB is a
 *  generous few seconds of MP3. The portal enforces the same limit. */
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

function isAlarmChoice(value: unknown): value is AlarmSoundChoice {
  if (value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === 'siren') {
    return true;
  }
  return isChoice(value) && value.kind !== 'none';
}

/** A clean copy of `value` when it is a usable scan-sound choice, else
 *  null (kioskConfig.ts keeps the old choice then). */
export function parseSoundChoice(value: unknown): SoundChoice | null {
  if (!isChoice(value)) return null;
  if (value.kind === 'none') return { kind: 'none' };
  return { kind: value.kind, id: value.id } as SoundChoice;
}

/** The same for the alarm's sound: the siren, a built-in or an upload. */
export function parseAlarmChoice(value: unknown): AlarmSoundChoice | null {
  if (!isAlarmChoice(value)) return null;
  if (value.kind === 'siren') return { kind: 'siren' };
  return { kind: value.kind, id: value.id } as AlarmSoundChoice;
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
        alarm: isAlarmChoice(parsed?.alarm) ? parsed.alarm : DEFAULT_SOUND_SETTINGS.alarm,
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

interface SoundRow extends UploadedSound {
  blob: Blob;
  /** The id is a portal id (uploaded or downloaded). Rows stored before
   *  sounds lived on the portal lack it; `uploadLocalSounds()` moves them. */
  portal?: boolean;
}

/** Name given to a sound downloaded from the portal (the download carries
 *  only the bytes). */
const PORTAL_SOUND_NAME = 'Sound from the portal';

function uploadErrorCode(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return 'too_large';
    if (err.status === 422) return 'not_audio';
  }
  return 'upload_failed';
}

/** Uploads `file` to the portal, then keeps a copy on this kiosk under the
 *  portal id. Rejects with `'not_audio'` for anything that isn't an audio
 *  file, `'too_large'` past `MAX_SOUND_BYTES`, and `'upload_failed'` when
 *  the portal can't be reached — the Sound tab turns each into inline
 *  copy. Nothing is stored locally unless the portal took it. */
export async function addUploadedSound(file: File): Promise<{ id: string; name: string }> {
  if (!file.type || !file.type.startsWith('audio/')) throw new Error('not_audio');
  if (file.size > MAX_SOUND_BYTES) throw new Error('too_large');
  let portalId: string;
  try {
    portalId = (await uploadKioskSound(file, file.name, getIdentity().serial)).id;
  } catch (err) {
    throw new Error(uploadErrorCode(err));
  }
  const row: SoundRow = {
    id: portalId,
    name: file.name,
    type: file.type,
    size: file.size,
    blob: file,
    created_at: new Date().toISOString(),
    portal: true,
  };
  await putRows('sounds', [row]);
  return { id: row.id, name: row.name };
}

/** Ids of every choice (scan slots and the alarm) that names an upload. */
function choiceUploadIds(settings: SoundSettings): string[] {
  return [settings.good, settings.not_found, settings.duplicate, settings.alarm]
    .flatMap((c) => (c.kind === 'upload' ? [c.id] : []));
}

/** Upload ids the current choices name that are still local-only (rows
 *  stored before sounds lived on the portal). A settings report must not
 *  name one: the portal would not know it. */
export async function localOnlyChoiceIds(): Promise<string[]> {
  const rows = await getAll<SoundRow>('sounds');
  const local = new Set(rows.filter((r) => !r.portal).map((r) => r.id));
  return choiceUploadIds(read()).filter((id) => local.has(id));
}

let remapping = false;

/** True while `uploadLocalSounds()` rewrites choices to portal ids. Those
 *  writes keep the same sounds under new ids, so kioskConfig.ts doesn't
 *  count them as a local change (a stamped first report would beat a
 *  portal edit made before it). */
export function remappingSounds(): boolean {
  return remapping;
}

/** Rewrites every choice naming a key of `map` to name its value instead
 *  (an empty value: the slot's default). */
function remapChoices(map: Map<string, string>, fallback: boolean): void {
  const settings = read();
  const patch: Partial<SoundSettings> = {};
  for (const slot of ['good', 'not_found', 'duplicate'] as const) {
    const c = settings[slot];
    if (c.kind !== 'upload' || !map.has(c.id)) continue;
    const to = map.get(c.id)!;
    patch[slot] = to ? { kind: 'upload', id: to }
      : (fallback ? DEFAULT_SOUND_SETTINGS[slot] : c);
  }
  const a = settings.alarm;
  if (a.kind === 'upload' && map.has(a.id)) {
    const to = map.get(a.id)!;
    patch.alarm = to ? { kind: 'upload', id: to } : { kind: 'siren' };
  }
  if (Object.keys(patch).length === 0) return;
  remapping = true;
  try {
    writeSoundSettings(patch);
  } finally {
    remapping = false;
  }
}

let uploadingLocal: Promise<boolean> | null = null;

/** Moves every local-only upload to the portal: each row is uploaded,
 *  stored again under its portal id, every choice naming it is remapped,
 *  and the old row is dropped. A row the portal refuses outright (413 /
 *  422) can never be named by a report, so it is dropped and its choices
 *  go back to the slot's default. Resolves true when no choice names a
 *  local-only upload any more; false when something still has to wait
 *  (offline, a server error). Single-flight; never rejects. */
export function uploadLocalSounds(): Promise<boolean> {
  uploadingLocal ??= (async () => {
    try {
      const rows = (await getAll<SoundRow>('sounds')).filter((r) => !r.portal);
      const serial = getIdentity().serial;
      for (const row of rows) {
        let portalId: string;
        try {
          portalId = (await uploadKioskSound(row.blob, row.name, serial)).id;
        } catch (err) {
          if (uploadErrorCode(err) === 'upload_failed') continue;
          await deleteRows('sounds', [row.id]);
          forgetObjectUrl(row.id);
          remapChoices(new Map([[row.id, '']]), true);
          continue;
        }
        await putRows('sounds', [{ ...row, id: portalId, portal: true }]);
        remapChoices(new Map([[row.id, portalId]]), false);
        await deleteRows('sounds', [row.id]);
        forgetObjectUrl(row.id);
      }
      return (await localOnlyChoiceIds()).length === 0;
    } catch {
      return false;
    } finally {
      uploadingLocal = null;
    }
  })();
  return uploadingLocal;
}

const downloading = new Map<string, Promise<boolean>>();
/** When each id last failed to download, so a scan storm doesn't hammer
 *  the API for a sound that isn't there. */
const failedAt = new Map<string, number>();
export const SOUND_RETRY_MS = 30_000;

/** Makes sure this kiosk holds a copy of the portal sound `id`: resolves
 *  true at once when it does, otherwise downloads and caches it. A failed
 *  download resolves false and is retried no sooner than
 *  `SOUND_RETRY_MS` later. Single-flight per id; never rejects. */
export function ensureSoundCached(id: string): Promise<boolean> {
  const pending = downloading.get(id);
  if (pending) return pending;
  const job = (async () => {
    try {
      const rows = await getAll<SoundRow>('sounds');
      if (rows.some((r) => r.id === id)) return true;
      const last = failedAt.get(id);
      if (last !== undefined && Date.now() - last < SOUND_RETRY_MS) return false;
      const blob = await downloadKioskSound(id);
      const row: SoundRow = {
        id,
        name: PORTAL_SOUND_NAME,
        type: blob.type,
        size: blob.size,
        blob,
        created_at: new Date().toISOString(),
        portal: true,
      };
      await putRows('sounds', [row]);
      failedAt.delete(id);
      return true;
    } catch {
      failedAt.set(id, Date.now());
      return false;
    } finally {
      downloading.delete(id);
    }
  })();
  downloading.set(id, job);
  return job;
}

/** Starts a download for every upload the current choices name that this
 *  kiosk doesn't hold. Fire-and-forget. */
export function cacheChosenSounds(): void {
  for (const id of choiceUploadIds(read())) void ensureSoundCached(id);
}

/** The uploads, oldest first — the blob itself is left out: nothing but
 *  playback needs it, and it is the heavy part of the row. */
export async function listUploadedSounds(): Promise<UploadedSound[]> {
  const rows = await getAll<SoundRow>('sounds');
  return rows
    .map(({ id, name, type, size, created_at }) => ({ id, name, type, size, created_at }))
    .sort((a, b) => compareOrdinal(a.created_at, b.created_at));
}

/** Deletes an upload, revokes its object URL, and resets any choice that
 *  pointed at it — a scan must never fall silent pointing at a row that
 *  no longer exists. */
export async function removeUploadedSound(id: string): Promise<void> {
  await deleteRows('sounds', [id]);
  forgetObjectUrl(id);
  const settings = read();
  const patch: Partial<SoundSettings> = {};
  if (settings.good.kind === 'upload' && settings.good.id === id) patch.good = { kind: 'none' };
  if (settings.not_found.kind === 'upload' && settings.not_found.id === id) {
    patch.not_found = { kind: 'none' };
  }
  if (settings.duplicate.kind === 'upload' && settings.duplicate.id === id) {
    patch.duplicate = { kind: 'none' };
  }
  // The alarm falls back to the siren, never to silence.
  if (settings.alarm.kind === 'upload' && settings.alarm.id === id) patch.alarm = { kind: 'siren' };
  if (patch.good || patch.not_found || patch.duplicate || patch.alarm) writeSoundSettings(patch);
}

/* ── Playback ──────────────────────────────────────────────────────── */

type AudioCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
/** The latest `resume()` still in flight (settled either way), or null. */
let resuming: Promise<void> | null = null;
const objectUrls = new Map<string, string>();

function forgetObjectUrl(id: string): void {
  const url = objectUrls.get(id);
  if (!url) return;
  objectUrls.delete(id);
  try { URL.revokeObjectURL(url); } catch { /* no URL API, nothing to revoke */ }
}

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
    if (ctx.state === 'suspended') {
      const pending: Promise<void> = Promise.resolve(ctx.resume()).then(
        () => undefined, () => undefined,
      );
      resuming = pending;
      void pending.then(() => { if (resuming === pending) resuming = null; });
    }
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

/** Plays the upload `id`, or — when this kiosk has no copy of it yet —
 *  `fallback` (the slot's default) while a download is started. */
async function playUpload(id: string, volume: number, fallback?: SoundChoice): Promise<void> {
  const url = await uploadUrl(id);
  if (!url) {
    void ensureSoundCached(id);
    if (fallback && fallback.kind === 'builtin') playBuiltin(fallback.id, volume);
    return;
  }
  const el = new Audio(url);
  el.volume = clampVolume(volume);
  await el.play();
}

/** Plays one choice at `volume` (the stored volume by default). Never
 *  throws and never rejects — the Sound tab's Play buttons and the scan
 *  path share it. An upload this kiosk doesn't hold yet plays `fallback`
 *  (silence when none is given) while it downloads. */
export function playSoundChoice(choice: SoundChoice, volume?: number, fallback?: SoundChoice): void {
  const level = volume ?? read().volume;
  try {
    if (choice.kind === 'none') return;
    if (choice.kind === 'builtin') {
      playBuiltin(choice.id, level);
      return;
    }
    void playUpload(choice.id, level, fallback).catch(() => undefined);
  } catch {
    /* audio must never break scanning */
  }
}

/** What the Scanning, Containers, and Trucks pages call beside
 *  `flash()` — one case per scan outcome, `duplicate` included: a repeat
 *  scan must not sound like the pack it is not. An upload not on this
 *  kiosk yet plays the outcome's default sound until it has downloaded. */
export function playScanSound(which: 'good' | 'not_found' | 'duplicate'): void {
  try {
    const settings = read();
    playSoundChoice(settings[which], settings.volume, DEFAULT_SOUND_SETTINGS[which]);
  } catch {
    /* audio must never break scanning */
  }
}

/* ── Alarm siren ───────────────────────────────────────────────────── */

/** The two siren pitches (Hz) and how often they swap: a square-wave LFO
 *  pushes one oscillator between them, so the loop needs no timers. */
const SIREN_LOW = 620;
const SIREN_HIGH = 960;
const SIREN_SWAPS_PER_S = 2.5;

/** Starts the Asset Not Part Of Move siren at `volume` (0–1): a two-tone
 *  wail that loops until the returned function is called. Never throws —
 *  with no Web Audio API, or a context that fails, it is silence and the
 *  returned stop is a no-op. Stopping twice is harmless. */
export function startSiren(volume: number): () => void {
  const nodes: { stop?: (when?: number) => void; disconnect?: () => void }[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const node of nodes) {
      try { node.stop?.(); } catch { /* already stopped */ }
      try { node.disconnect?.(); } catch { /* already disconnected */ }
    }
  };
  try {
    const audio = audioContext();
    if (!audio) return stop;
    const tone = audio.createOscillator();
    nodes.push(tone);
    const lfo = audio.createOscillator();
    nodes.push(lfo);
    const depth = audio.createGain();
    nodes.push(depth);
    const out = audio.createGain();
    nodes.push(out);

    const now = audio.currentTime;
    const floor = 0.0001;
    const peak = Math.max(floor, clampVolume(volume) * 0.5);
    tone.type = 'sawtooth';
    tone.frequency.setValueAtTime((SIREN_LOW + SIREN_HIGH) / 2, now);
    // A square LFO at half the swap rate: each half-cycle is one pitch.
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(SIREN_SWAPS_PER_S / 2, now);
    depth.gain.setValueAtTime((SIREN_HIGH - SIREN_LOW) / 2, now);
    out.gain.setValueAtTime(floor, now);
    out.gain.exponentialRampToValueAtTime(peak, now + 0.02);

    lfo.connect(depth);
    depth.connect(tone.frequency);
    tone.connect(out);
    out.connect(audio.destination);
    lfo.start(now);
    tone.start(now);
  } catch {
    // A half-built siren is torn down; the alarm carries on silent.
    stop();
  }
  return stop;
}

/** A built-in repeats with this much quiet after its last note. */
const ALARM_REPEAT_GAP_MS = 350;

function builtinLength(id: BuiltinSoundId): number {
  return Math.max(...BUILTIN_TONES[id].map((t) => t.at + t.ms));
}

/** Starts the off-move alarm's sound (the stored choice and volume unless
 *  given) and loops it until the returned function is called: the siren
 *  as itself, a built-in replayed back to back, an upload on `loop`.
 *  Never throws; stopping twice is harmless. */
export function startAlarmSound(choice?: AlarmSoundChoice, volume?: number): () => void {
  const settings = read();
  const which = choice ?? settings.alarm;
  const level = volume ?? settings.volume;
  if (which.kind === 'siren') return startSiren(level);
  let stopped = false;
  if (which.kind === 'builtin') {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      playBuiltin(which.id, level);
      timer = setInterval(() => {
        try { playBuiltin(which.id, level); } catch { /* silence, never a crash */ }
      }, builtinLength(which.id) + ALARM_REPEAT_GAP_MS);
    } catch {
      /* the alarm carries on silent */
    }
    return () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }
  let el: HTMLAudioElement | null = null;
  let stopSiren: (() => void) | null = null;
  void uploadUrl(which.id).then((url) => {
    if (stopped) return;
    if (!url) {
      // Not on this kiosk yet: the siren (the alarm's default) sounds
      // while the copy downloads — an alarm is never silent.
      void ensureSoundCached(which.id);
      stopSiren = startSiren(level);
      return;
    }
    el = new Audio(url);
    el.loop = true;
    el.volume = clampVolume(level);
    return el.play();
  }).catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    try { el?.pause(); } catch { /* already gone */ }
    stopSiren?.();
  };
}

/** True when the shared context exists but is still suspended after
 *  `resume()` — the browser wants a tap or key press before it plays.
 *  False with no context at all (nothing has tried to play). */
export function soundBlocked(): boolean {
  try {
    return ctx !== null && ctx.state === 'suspended';
  } catch {
    return false;
  }
}

/** Resolves once the latest `resume()` has settled (at once when none is
 *  pending), so `soundBlocked()` reads the real state rather than the
 *  moment before a resume lands. A browser holding the context back for
 *  a gesture may leave it pending, so callers also re-check on a timer. */
export function soundSettled(): Promise<void> {
  return resuming ?? Promise.resolve();
}

/** Test helper: drops the shared context and the object-URL cache so a
 *  case can swap the audio API out from under the module. */
export function resetSoundAudioForTest(): void {
  ctx = null;
  resuming = null;
  objectUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch { /* no URL API */ }
  });
  objectUrls.clear();
  downloading.clear();
  failedAt.clear();
  uploadingLocal = null;
}
