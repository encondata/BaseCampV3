/**
 * Kiosk settings sync with the portal (web kiosks).
 *
 * The portal holds one config document per kiosk (`schema: 1`, sections
 * `appearance`, `sound`, `checkpoints`, `developer`, `alarm`,
 * `android_rfid`, `ios`, plus anything a later app adds). This module:
 *
 *  - **builds** that document from this kiosk's own stores
 *    (`collectConfig`): the four sections a web kiosk owns are read from
 *    `appearance.ts`, `sound.ts`, `checkpointSettings.ts` and
 *    `devMode.ts`; every other section is the last received document's,
 *    kept verbatim. The portal resets a validated section a report
 *    omits, so the whole document always goes back.
 *  - **applies** a received one (`applyConfig`) through the stores' own
 *    setters (so their clamping still holds). A field it can't apply
 *    keeps its old value; nothing throws; an apply never counts as a
 *    local change.
 *  - **tracks local changes** (`installConfigTracking`): any write to
 *    those stores marks the config dirty, stamped with portal-corrected
 *    time (`Date.now() + serverOffset`), so a kiosk with a wrong clock
 *    can't win by accident.
 *  - **rides the person heartbeat** (`configBeatFields` before a beat,
 *    `handleConfigReply` after it). A beat carries the whole config when
 *    it is dirty, when this kiosk has never reported, and every 60
 *    minutes; every beat carries the applied version. Before any report,
 *    uploads still held only on this kiosk are moved to the portal so the
 *    report never names a sound the portal doesn't know.
 *
 * Laptop mode: the edge owns the laptop's config (it adds the sync fields
 * to the beats it proxies), so the heartbeat and tracking entry points do
 * nothing there. `collectConfig` / `applyConfig` stay usable for the
 * laptop's own `/edge/config` path.
 *
 * Sync state lives in localStorage (`ss.kiosk.configSync`), not in the
 * IndexedDB `meta` store, which "Clear local data" empties.
 */

import type { HeartbeatConfigFields, HeartbeatResult } from './api';
import { readAppearance, subscribeAppearance, writeAppearance, type Appearance, type Hsl } from './appearance';
import {
  readCheckpoint, subscribeCheckpoints, writeCheckpoint, type CheckpointId,
} from './checkpointSettings';
import { readDevMode, subscribeDevMode, writeDevMode } from './devMode';
import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { isLaptop } from './platform';
import {
  cacheChosenSounds, parseAlarmChoice, parseSoundChoice, readSoundSettings, remappingSounds,
  subscribeSoundSettings, uploadLocalSounds, writeSoundSettings, type SoundSettings,
} from './sound';

export type ConfigDoc = { schema: 1 } & Record<string, unknown>;

/** The sections a web kiosk reads from and writes to its own stores. */
export const OWNED_SECTIONS = ['appearance', 'sound', 'checkpoints', 'developer'] as const;

/** A full report goes out at least this often. */
export const REPORT_INTERVAL_MS = 60 * 60_000;

/** How long a beat waits for the local-sound move before going without
 *  its report (the next beat tries again). */
export const SOUND_UPLOAD_WAIT_MS = 15_000;

/** Config key ↔ checkpointSettings id. */
const CHECKPOINTS: [string, CheckpointId][] = [
  ['enroll', 'enroll'],
  ['container_pack', 'containerPack'],
  ['container_unpack', 'containerUnpack'],
  ['truck_load', 'truckLoad'],
  ['truck_unload', 'truckUnload'],
];

const CHECKPOINT_MAX = 100;

const KEY = 'ss.kiosk.configSync';

export interface ConfigSyncState {
  /** The last document received from the portal, kept whole. */
  base: Record<string, unknown> | null;
  /** The portal `config_version` this kiosk last applied. */
  applied_version: number | null;
  /** A local change the portal hasn't accepted yet. */
  dirty: boolean;
  /** When the config last changed here, in portal-corrected time (ISO). */
  changed_at: string | null;
  /** A change made before the kiosk ever learned the portal's clock: its
   *  raw local time, corrected once the offset is known. */
  changed_at_local: number | null;
  /** When the last report went out (this kiosk's clock, ms). */
  last_report_at: number | null;
  /** Portal time minus this kiosk's time, ms. */
  server_offset_ms: number | null;
}

const EMPTY: ConfigSyncState = {
  base: null, applied_version: null, dirty: false, changed_at: null,
  changed_at_local: null, last_report_at: null, server_offset_ms: null,
};

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readConfigState(): ConfigSyncState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!isObj(p)) return { ...EMPTY };
    return {
      base: isObj(p.base) ? p.base : null,
      applied_version: finiteOrNull(p.applied_version),
      dirty: p.dirty === true,
      changed_at: typeof p.changed_at === 'string' ? p.changed_at : null,
      changed_at_local: finiteOrNull(p.changed_at_local),
      last_report_at: finiteOrNull(p.last_report_at),
      server_offset_ms: finiteOrNull(p.server_offset_ms),
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeState(patch: Partial<ConfigSyncState>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readConfigState(), ...patch }));
  } catch {
    /* a refused store just means the next beat reports again */
  }
}

/** Bumped by every local change, so a beat can tell whether one landed
 *  while it was in flight. */
let generation = 0;
/** True while `applyConfig` writes the stores: those writes aren't
 *  local changes. */
let applying = false;

/** This kiosk's best idea of the portal's current time (ms). */
export function correctedNow(): number {
  return Date.now() + (readConfigState().server_offset_ms ?? 0);
}

/* ── Building and applying ─────────────────────────────────────────── */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hslCopy({ h, s, l }: Hsl): Hsl {
  return { h, s, l };
}

/** The whole config document: this kiosk's four sections over the last
 *  received document, whose other sections (`alarm`, `android_rfid`,
 *  `ios`, unknown ones) pass through untouched. */
export function collectConfig(): ConfigDoc {
  const base = readConfigState().base ?? {};
  const doc = clone(base) as Record<string, unknown>;
  const section = (name: string) => (isObj(doc[name]) ? doc[name] as Record<string, unknown> : {});
  const a: Appearance = readAppearance();
  const s: SoundSettings = readSoundSettings();
  doc.schema = 1;
  doc.appearance = {
    ...section('appearance'),
    good_scan: hslCopy(a.good_scan),
    not_found_scan: hslCopy(a.not_found_scan),
    duplicate_scan: hslCopy(a.duplicate_scan),
    flash_ms: a.flash_ms,
  };
  doc.sound = {
    ...section('sound'),
    good: clone(s.good),
    not_found: clone(s.not_found),
    duplicate: clone(s.duplicate),
    alarm: clone(s.alarm),
    volume: s.volume,
  };
  const checkpoints: Record<string, unknown> = { ...section('checkpoints') };
  for (const [key, id] of CHECKPOINTS) checkpoints[key] = readCheckpoint(id);
  doc.checkpoints = checkpoints;
  doc.developer = { ...section('developer'), dev_mode: readDevMode() };
  return doc as ConfigDoc;
}

function asHsl(value: unknown): Hsl | null {
  if (!isObj(value)) return null;
  const ok = (n: unknown, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  return ok(value.h, 360) && ok(value.s, 100) && ok(value.l, 100)
    ? { h: value.h as number, s: value.s as number, l: value.l as number } : null;
}

/** Runs `fn`, swallowing anything it throws: one bad section must never
 *  stop the rest from applying. */
function guarded(fn: () => void): void {
  try { fn(); } catch { /* that field keeps its old value */ }
}

function applyAppearance(sec: unknown): void {
  if (!isObj(sec)) return;
  const patch: Partial<Appearance> = {};
  for (const key of ['good_scan', 'not_found_scan', 'duplicate_scan'] as const) {
    const hsl = asHsl(sec[key]);
    if (hsl) patch[key] = hsl;
  }
  // Any finite number goes through the setter, which clamps it to
  // 100–2000 the same way the Appearance slider's writes are.
  const ms = finiteOrNull(sec.flash_ms);
  if (ms !== null) patch.flash_ms = ms;
  if (Object.keys(patch).length > 0) writeAppearance(patch);
}

function applySound(sec: unknown): void {
  if (!isObj(sec)) return;
  const patch: Partial<SoundSettings> = {};
  for (const key of ['good', 'not_found', 'duplicate'] as const) {
    const choice = parseSoundChoice(sec[key]);
    if (choice) patch[key] = choice;
  }
  const alarm = parseAlarmChoice(sec.alarm);
  if (alarm) patch.alarm = alarm;
  const volume = finiteOrNull(sec.volume);
  if (volume !== null) patch.volume = volume;     // the setter clamps to 0–1
  if (Object.keys(patch).length > 0) writeSoundSettings(patch);
}

function applyCheckpoints(sec: unknown): void {
  if (!isObj(sec)) return;
  for (const [key, id] of CHECKPOINTS) {
    const value = sec[key];
    if (typeof value !== 'string' || !value.trim() || value.length > CHECKPOINT_MAX) continue;
    if (readCheckpoint(id) !== value) writeCheckpoint(id, value);
  }
}

function applyDeveloper(sec: unknown): void {
  if (!isObj(sec) || typeof sec.dev_mode !== 'boolean') return;
  if (readDevMode() !== sec.dev_mode) writeDevMode(sec.dev_mode);
}

/** Applies a document from the portal to this kiosk's stores and records
 *  `version` as applied. A field this kiosk can't apply keeps its old
 *  value. Never throws, and never counts as a local change. A document
 *  that isn't an object is ignored entirely (and not recorded). */
export function applyConfig(doc: unknown, version: number | null): void {
  if (!isObj(doc)) return;
  applying = true;
  try {
    guarded(() => applyAppearance(doc.appearance));
    guarded(() => applySound(doc.sound));
    guarded(() => applyCheckpoints(doc.checkpoints));
    guarded(() => applyDeveloper(doc.developer));
    guarded(() => writeState({
      base: clone(doc),
      ...(version !== null && Number.isFinite(version) ? { applied_version: version } : {}),
    }));
  } finally {
    applying = false;
  }
  // A choice naming a portal sound this kiosk doesn't hold downloads now;
  // the slot plays its default until the copy lands.
  guarded(() => cacheChosenSounds());
}

/* ── Local change tracking ─────────────────────────────────────────── */

/** Marks the config changed here, stamped with portal-corrected time
 *  (or, before the kiosk has ever heard the portal's clock, with its raw
 *  time to correct later). */
export function markConfigChanged(): void {
  generation += 1;
  const offset = readConfigState().server_offset_ms;
  if (offset !== null) {
    writeState({
      dirty: true, changed_at: new Date(Date.now() + offset).toISOString(), changed_at_local: null,
    });
  } else {
    writeState({ dirty: true, changed_at_local: Date.now() });
  }
}

let tracking: (() => void) | null = null;

/** Starts marking the config dirty on every local write to the four
 *  owned stores. Idempotent; returns the stop function. Does nothing on
 *  a laptop (the edge tracks the laptop's config). */
export function installConfigTracking(): () => void {
  if (isLaptop()) return () => undefined;
  if (!tracking) {
    const onChange = () => { if (!applying && !remappingSounds()) markConfigChanged(); };
    const offs = [
      subscribeAppearance(onChange),
      subscribeSoundSettings(onChange),
      subscribeCheckpoints(onChange),
      subscribeDevMode(onChange),
    ];
    tracking = () => {
      offs.forEach((off) => off());
      tracking = null;
    };
  }
  return tracking;
}

/* ── Heartbeat integration ─────────────────────────────────────────── */

export interface ConfigBeat {
  fields: HeartbeatConfigFields;
  /** The beat carries a full report. */
  reported: boolean;
  /** A report was due but held back until the portal's clock is known. */
  awaitingClock: boolean;
  /** `generation` when the beat was built. */
  generation: number;
  /** This kiosk's clock when the beat went out. */
  sentAt: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** The stamp a report carries: null only when nothing has ever changed
 *  here (the unstamped first report), undefined when a change is waiting
 *  for the portal's clock. */
function reportStamp(st: ConfigSyncState): string | null | undefined {
  if (st.changed_at_local !== null) {
    if (st.server_offset_ms === null) return undefined;
    return new Date(st.changed_at_local + st.server_offset_ms).toISOString();
  }
  return st.changed_at;
}

/** The settings fields for the next person heartbeat, or null on a
 *  laptop. Always carries `config_applied_version`; carries the whole
 *  config when it is dirty, when this kiosk has never reported, and when
 *  the last report is 60 minutes old. Never rejects. */
export async function configBeatFields(): Promise<ConfigBeat | null> {
  if (isLaptop()) return null;
  try {
    const before = readConfigState();
    const now = Date.now();
    const due = before.dirty || before.last_report_at === null
      || now - before.last_report_at >= REPORT_INTERVAL_MS || now < before.last_report_at;
    let reported = false;
    let awaitingClock = false;
    let config: ConfigDoc | undefined;
    let stamp: string | null | undefined;
    // Local sounds go to the portal before any report can name them. The
    // move rewrites choices to the new ids (not a local change: the
    // sounds are the same), so the document is collected afterward.
    if (due && await withTimeout(uploadLocalSounds(), SOUND_UPLOAD_WAIT_MS, false)) {
      const st = readConfigState();
      stamp = reportStamp(st);
      if (stamp === undefined) {
        awaitingClock = true;
      } else {
        config = collectConfig();
        reported = true;
      }
    }
    const st = readConfigState();
    return {
      fields: {
        config_applied_version: st.applied_version,
        ...(reported ? { config, config_changed_at: stamp ?? null } : {}),
      },
      reported,
      awaitingClock,
      generation,
      sentAt: Date.now(),
    };
  } catch {
    return {
      fields: { config_applied_version: readConfigState().applied_version },
      reported: false, awaitingClock: false, generation, sentAt: Date.now(),
    };
  }
}

/** Handles a heartbeat reply for the beat `beat` described: keeps the
 *  portal's clock offset, settles the report, applies a received config
 *  (unless a local change is still waiting to be reported, which the
 *  portal judges by its stamp first), and updates the setup's scan type.
 *  Returns `rebeat: true` when a held-back report can now go out. Never
 *  throws. */
export function handleConfigReply(
  result: HeartbeatResult, beat: ConfigBeat | null,
): { rebeat: boolean } {
  if (isLaptop() || !beat) return { rebeat: false };
  let rebeat = false;
  guarded(() => {
    const receivedAt = Date.now();
    const serverMs = typeof result.server_time === 'string' ? Date.parse(result.server_time) : NaN;
    if (Number.isFinite(serverMs)) {
      const offset = Math.round(serverMs - (beat.sentAt + receivedAt) / 2);
      const st = readConfigState();
      writeState({
        server_offset_ms: offset,
        ...(st.changed_at_local !== null ? {
          changed_at: new Date(st.changed_at_local + offset).toISOString(),
          changed_at_local: null,
        } : {}),
      });
      rebeat = beat.awaitingClock;
    }
    if (beat.reported) {
      writeState({
        last_report_at: receivedAt,
        ...(generation === beat.generation ? { dirty: false } : {}),
      });
    }
    const st = readConfigState();
    if (isObj(result.config) && !st.dirty && generation === beat.generation) {
      applyConfig(result.config, finiteOrNull(result.config_version));
    }
  });
  guarded(() => applyScanType(result.scan_status, result.scan_status_label));
  return { rebeat };
}

/** The portal's scan type for this kiosk, written into the saved setup
 *  when it differs — no rerun of Kiosk Setup. */
function applyScanType(status: unknown, label: unknown): void {
  if (typeof status !== 'string' || !status || typeof label !== 'string') return;
  const setup = readKioskSetup();
  if (!setup || (setup.scanStatus === status && setup.scanLabel === label)) return;
  writeKioskSetup({ ...setup, scanStatus: status, scanLabel: label });
}

/** Test helper: forgets the sync state and stops tracking. */
export function resetConfigSyncForTest(): void {
  tracking?.();
  tracking = null;
  generation = 0;
  applying = false;
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
