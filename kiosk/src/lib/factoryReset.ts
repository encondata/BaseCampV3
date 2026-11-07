/**
 * Clear Setup — the Developer tab's way back to an out-of-box kiosk, for
 * testing setup and the features from scratch (Jimmy, 2026-11-07: "does
 * the same as the Clear button from the portal and erases all local data
 * and resets any config to default").
 *
 * It goes further than the portal's Clear (which only drops the setup)
 * and further than "Clear local data" (which keeps unsent scans and
 * sounds). What survives is only who this kiosk is — its name, its serial
 * and so its portal registration (Jimmy: "we can keep name and
 * registration, the testing is more about setup and function") — plus the
 * bookkeeping that carries the reset to the portal.
 *
 * Why the settings go back through their own setters, not by deleting
 * their keys: the portal keeps one settings document per kiosk and the
 * NEWER copy wins (kioskConfig.ts). A setter write is recorded as a local
 * change stamped now (on a laptop, as a pending push to the laptop's
 * service), so the defaults win at the next check-in. Deleting the keys
 * records nothing, and the portal's saved settings would simply come back.
 * For the same reason `ss.kiosk.configSync` and
 * `ss.kiosk.laptopConfigPending` are kept.
 *
 * On a laptop the setup and the move live in the laptop's own service and
 * the browser is refilled from it, so a browser-only reset would undo
 * itself. The laptop is wiped first (`/edge/wipe`, forced — the person
 * already confirmed losing unsent data) and a failure stops everything
 * before the browser is touched. The laptop's identity is fixed on the
 * laptop by design and is untouched either way.
 *
 * The caller reloads the app afterwards: in-memory state (the outbox
 * drainer, sync status, the label build worker) must not outlive the data
 * it describes.
 */

import { edgeWipe, getEdgeStatus } from './api';
import { DEFAULT_APPEARANCE, writeAppearance } from './appearance';
import { CHECKPOINT_IDS, defaultCheckpoint, writeCheckpoint } from './checkpointSettings';
import { writeDevMode } from './devMode';
import { flushLaptopConfig } from './laptopConfig';
import { clearEverything, getAll } from './localDb';
import { isLaptop } from './platform';
import { DEFAULT_SOUND_SETTINGS, writeSoundSettings } from './sound';

/** localStorage keys that survive: who this kiosk is, and the sync
 *  bookkeeping that carries the defaults to the portal. */
export const KEEP_KEYS: readonly string[] = [
  'ss.kiosk.serial',
  'ss.kiosk.name',
  'ss.kiosk.configSync',
  'ss.kiosk.laptopConfigPending',
  // the portal Clear's handshake: dropping it would re-apply an old
  // request and show "an administrator cleared this kiosk" for nothing
  'ss.kiosk.setupClear',
];

/** Kiosk settings kept under a key outside the `ss.kiosk.` prefix (the
 *  label alignment offsets are shared with the portal's Print Labels). */
const OTHER_KEYS: readonly string[] = ['labels.print.settings'];

/** Outbox states that have not reached the portal. `accepted` has;
 *  `nomatch` never goes. */
const UNSENT = new Set(['queued', 'sending', 'retrying', 'failed']);

export interface ClearSetupDeps {
  /** Send a check-in now, carrying the reset settings (web kiosk). */
  heartbeatNow: () => Promise<void>;
  logout: () => Promise<void>;
}

/** Every synced setting back to its default, through its own setter so
 *  the change is recorded (see the header). */
export function resetSettingsToDefaults(): void {
  writeAppearance(DEFAULT_APPEARANCE);
  writeSoundSettings(DEFAULT_SOUND_SETTINGS);
  for (const id of CHECKPOINT_IDS) writeCheckpoint(id, defaultCheckpoint(id));
  writeDevMode(false);
}

/** Every kiosk key except KEEP_KEYS: the setup, the setup state, and the
 *  settings only this kiosk holds. Synced settings already read as their
 *  defaults, so removing their keys too changes nothing. */
export function clearKioskStorage(): void {
  let keys: string[];
  try {
    keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((k): k is string => k !== null);
  } catch {
    return;                                   // storage blocked: nothing kept here anyway
  }
  for (const key of keys) {
    const ours = key.startsWith('ss.kiosk.') || OTHER_KEYS.includes(key);
    if (!ours || KEEP_KEYS.includes(key)) continue;
    try { localStorage.removeItem(key); } catch { /* best effort */ }
  }
}

function settle(p: () => Promise<unknown>): Promise<void> {
  return p().then(() => undefined, () => undefined);
}

/** How many scans would be lost: this browser's unsent outbox rows, plus
 *  on a laptop what the laptop itself still has to upload. A laptop that
 *  can't be asked still reports the browser's count. */
export async function countUnsent(): Promise<number> {
  let n = 0;
  try {
    const rows = await getAll<{ status: string }>('outbox');
    n += rows.filter((r) => UNSENT.has(r.status)).length;
  } catch { /* no local outbox */ }
  if (isLaptop()) {
    try {
      const status = await getEdgeStatus() as unknown as {
        outbox?: Record<string, number>;
        rfid_uploads?: { pending?: number; waiting_for_internet?: number };
      };
      for (const [state, count] of Object.entries(status.outbox ?? {})) {
        if (UNSENT.has(state)) n += count;
      }
      n += (status.rfid_uploads?.pending ?? 0) + (status.rfid_uploads?.waiting_for_internet ?? 0);
    } catch { /* the laptop can't be asked: the browser's count stands */ }
  }
  return n;
}

/** Runs Clear Setup. Rejects only when the laptop wipe fails — and then
 *  nothing in the browser has been cleared. The caller reloads after. */
export async function runClearSetup({ heartbeatNow, logout }: ClearSetupDeps): Promise<void> {
  resetSettingsToDefaults();
  if (isLaptop()) {
    // hand the defaults to the laptop while this session can still do it;
    // anything left pending goes after the next sign-in
    await settle(flushLaptopConfig);
    await edgeWipe('WIPE');                   // throws: stop before the browser is touched
  } else {
    await settle(heartbeatNow);               // offline is fine: it goes at the next sign-in
  }
  await clearEverything();
  clearKioskStorage();
  // the laptop wipe already ended the session there
  if (!isLaptop()) await settle(logout);
}
