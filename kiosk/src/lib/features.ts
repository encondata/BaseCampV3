/** The kiosk's feature registry: what the Home launcher tiles link to,
 *  what routes exist, and what the top bar's section label reads.
 *  Permission gating of tiles is deferred (see spec). Tile availability
 *  by kiosk setup state is handled here via `alwaysAvailable` /
 *  `featureAvailable` — see `setupState.ts`. */

import type { StationType } from './kioskSetup';
import { isSetupComplete, type KioskSetupState } from './setupState';

export interface KioskFeature {
  id: 'setup' | 'rfid' | 'clock' | 'scan' | 'enroll' | 'containers' | 'trucks' | 'lookup' | 'labels'
  | 'timeclock' | 'dock' | 'settings';
  path: string;
  title: string;
  blurb: string;
  /** True for features that still fall back to the generic FeaturePage
   *  placeholder; absent for features with a real screen (Settings,
   *  Kiosk Setup, Scanning, RFID Enroll, Containers, Trucks, Label
   *  Printing, and Timeclock — which is to say all of them today; the
   *  flag stays for the next one). */
  placeholder?: boolean;
  /** True for the two tiles that stay usable no matter the kiosk setup
   *  state (Kiosk Setup and Settings) — see `featureAvailable`. */
  alwaysAvailable?: boolean;
}

export const FEATURES: KioskFeature[] = [
  { id: 'setup', path: '/setup', title: 'Kiosk Setup', blurb: 'Set up this kiosk for a move.', alwaysAvailable: true },
  { id: 'scan', path: '/scan', title: 'Scanning', blurb: 'Scan assets, containers, and badges.' },
  { id: 'enroll', path: '/enroll', title: 'RFID Enroll', blurb: 'Scan an asset, then scan its RFID tag.' },
  { id: 'containers', path: '/containers', title: 'Containers', blurb: 'Pack and unpack containers by scanning.' },
  { id: 'trucks', path: '/trucks', title: 'Trucks', blurb: 'Load and unload trucks by scanning.' },
  { id: 'lookup', path: '/lookup', title: 'Asset Lookup', blurb: 'Scan an asset to see what it is and where it goes.' },
  // Asset labels only for now: container labels come later on every kiosk.
  { id: 'labels', path: '/labels', title: 'Label Printing', blurb: 'Print asset labels.' },
  { id: 'timeclock', path: '/timeclock', title: 'Timeclock', blurb: 'Clock in and out of a move.' },
  { id: 'settings', path: '/settings', title: 'Settings', blurb: 'Appearance, sound, devices, and more.', alwaysAvailable: true },
];

/** Whether a tile/route may be used given the kiosk's setup state — always
 *  true for `alwaysAvailable` features (Kiosk Setup, Settings) or when
 *  developer mode is on (Jimmy: "developer mode overrides this to always
 *  allow all options"), otherwise only once setup is complete. */
export function featureAvailable(
  feature: KioskFeature,
  setupState: KioskSetupState,
  devMode = false,
): boolean {
  return devMode || feature.alwaysAvailable || isSetupComplete(setupState);
}

/** The RFID Reader Dashboard's Home tile. Not in FEATURES: Home shows it
 *  only on a laptop whose saved setup is an RFID station, and it is first
 *  when shown (the station's main screen). Gated like the other tiles. */
export const RFID_READER_FEATURE: KioskFeature = {
  id: 'rfid', path: '/rfid_status', title: 'RFID Reader', blurb: 'Start or stop the reader and watch live activity.',
};

/** The Time Clock station's Home tile: starts the signed-out punch screen.
 *  Not in FEATURES: Home shows it only on a laptop whose saved setup is a
 *  Time Clock station, first when shown. Gated like the other tiles. */
export const TIMECLOCK_STATION_FEATURE: KioskFeature = {
  id: 'clock', path: '/timeclock/station', title: 'Time Clock',
  blurb: 'Start the time clock for workers.',
};

/** The Dock station's Home tile: its pass screen. Not in FEATURES: Home
 *  shows it only on a laptop whose saved setup is a Dock, first when shown.
 *  Gated like the other tiles. */
export const DOCK_FEATURE: KioskFeature = {
  id: 'dock', path: '/dock', title: 'Dock',
  blurb: 'Watch crates pass the curtain and what each one packed.',
};

/** What a laptop station's Home shows (Jimmy, 2026-10-02): an RFID Station
 *  only RFID Reader, Kiosk Setup and Settings; a Label Station only Kiosk
 *  Setup, Label Printing and Settings; a Time Clock station only Time
 *  Clock, Kiosk Setup and Settings; a Dock its Dock screen, then RFID
 *  Reader (start/stop and live reads), Kiosk Setup and Settings. Anything
 *  else (web mode, or a laptop not set up yet) shows every feature. */
const STATION_TILES: Record<StationType, KioskFeature['id'][]> = {
  rfid: ['rfid', 'setup', 'settings'],
  label: ['setup', 'labels', 'settings'],
  timeclock: ['clock', 'setup', 'settings'],
  dock: ['dock', 'rfid', 'setup', 'settings'],
};

export function homeFeatures(laptop: boolean, stationType: StationType | undefined): KioskFeature[] {
  if (!laptop || !stationType) return FEATURES;
  const all = [DOCK_FEATURE, RFID_READER_FEATURE, TIMECLOCK_STATION_FEATURE, ...FEATURES];
  return STATION_TILES[stationType]
    .map((id) => all.find((f) => f.id === id))
    .filter((f): f is KioskFeature => f !== undefined);
}
