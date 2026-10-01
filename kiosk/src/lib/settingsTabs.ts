/** The Settings page's tab registry: what sections exist, their blurbs,
 *  and which ones require a role the signed-in person might not hold.
 *  Gating is by visibility only — a tab the person lacks is not rendered,
 *  never shown disabled (see Settings.tsx). */

export type SettingsTabId = 'appearance' | 'sound' | 'devices' | 'this-kiosk' | 'edge' | 'admin' | 'developer';

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  blurb: string;
  requires?: 'admin' | 'developer';
  /** True for tabs usable while signed out (only This Kiosk, today) — see
   *  `visibleTabs`. */
  anon?: boolean;
  /** Only in the laptop edition (the edge's own controls). */
  laptopOnly?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'appearance', label: 'Appearance', blurb: 'Theme, accent, and text size for this kiosk.' },
  { id: 'sound', label: 'Sound', blurb: 'Scan and alert sounds.' },
  { id: 'devices', label: 'Devices', blurb: 'Scanners, printers, and readers attached to this kiosk.' },
  { id: 'this-kiosk', label: 'This Kiosk', blurb: "This kiosk's name, identity, and connection.", anon: true },
  { id: 'edge', label: 'Edge', blurb: 'Cloud connection, local move data, and the upload queue for this laptop.', laptopOnly: true },
  { id: 'admin', label: 'Admin', blurb: 'Kiosk administration.', requires: 'admin' },
  { id: 'developer', label: 'Developer', blurb: 'Diagnostics and developer tools.', requires: 'developer' },
];

export function visibleTabs(
  tabs: SettingsTab[],
  { isAdmin, isDeveloper, signedIn, laptop = false }:
    { isAdmin: boolean; isDeveloper: boolean; signedIn: boolean; laptop?: boolean },
): SettingsTab[] {
  const forMode = tabs.filter((t) => laptop || !t.laptopOnly);
  if (!signedIn) return forMode.filter((t) => t.anon);
  return forMode.filter((t) => {
    if (t.requires === 'admin') return isAdmin;
    if (t.requires === 'developer') return isDeveloper;
    return true;
  });
}
