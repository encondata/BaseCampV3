/** The Settings page's tab registry: what sections exist, their blurbs,
 *  and which ones require a role the signed-in person might not hold.
 *  Gating is by visibility only — a tab the person lacks is not rendered,
 *  never shown disabled (see Settings.tsx). */

export type SettingsTabId = 'appearance' | 'sound' | 'devices' | 'this-kiosk' | 'admin' | 'developer';

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  blurb: string;
  requires?: 'admin' | 'developer';
  /** True for tabs usable while signed out (only This Kiosk, today) — see
   *  `visibleTabs`. */
  anon?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'appearance', label: 'Appearance', blurb: 'Theme, accent, and text size for this kiosk.' },
  { id: 'sound', label: 'Sound', blurb: 'Scan and alert sounds.' },
  { id: 'devices', label: 'Devices', blurb: 'Scanners, printers, and readers attached to this kiosk.' },
  { id: 'this-kiosk', label: 'This Kiosk', blurb: "This kiosk's name, identity, and connection.", anon: true },
  { id: 'admin', label: 'Admin', blurb: 'Kiosk administration.', requires: 'admin' },
  { id: 'developer', label: 'Developer', blurb: 'Diagnostics and developer tools.', requires: 'developer' },
];

export function visibleTabs(
  tabs: SettingsTab[],
  { isAdmin, isDeveloper, signedIn }: { isAdmin: boolean; isDeveloper: boolean; signedIn: boolean },
): SettingsTab[] {
  if (!signedIn) return tabs.filter((t) => t.anon);
  return tabs.filter((t) => {
    if (t.requires === 'admin') return isAdmin;
    if (t.requires === 'developer') return isDeveloper;
    return true;
  });
}
