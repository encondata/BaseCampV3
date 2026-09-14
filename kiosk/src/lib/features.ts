/** The kiosk's feature registry: what the Home launcher tiles link to,
 *  what routes exist, and what the top bar's section label reads.
 *  Permission gating of tiles is deferred (see spec). Tile availability
 *  by kiosk setup state is handled here via `alwaysAvailable` /
 *  `featureAvailable` — see `setupState.ts`. */

import { isSetupComplete, type KioskSetupState } from './setupState';

export interface KioskFeature {
  id: 'setup' | 'scan' | 'labels' | 'timeclock' | 'settings';
  path: string;
  title: string;
  blurb: string;
  /** True for features that still fall back to the generic FeaturePage
   *  placeholder; absent for features with a real screen (Settings,
   *  Kiosk Setup, and Scanning). */
  placeholder?: boolean;
  /** True for the two tiles that stay usable no matter the kiosk setup
   *  state (Kiosk Setup and Settings) — see `featureAvailable`. */
  alwaysAvailable?: boolean;
}

export const FEATURES: KioskFeature[] = [
  { id: 'setup', path: '/setup', title: 'Kiosk Setup', blurb: 'Set up this kiosk for a move.', alwaysAvailable: true },
  { id: 'scan', path: '/scan', title: 'Scanning', blurb: 'Scan assets, containers, and badges.' },
  { id: 'labels', path: '/labels', title: 'Label Printing', blurb: 'Print asset and container labels.', placeholder: true },
  { id: 'timeclock', path: '/timeclock', title: 'Timeclock', blurb: 'Clock in and out of a move.', placeholder: true },
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
