/**
 * UI preferences — stored on the user's account (server-side), so every
 * device gets their normal display at login. This module only knows how
 * to APPLY preferences to the shell; persistence lives in AuthContext
 * (savePreferencesRequest). Ref: fibertrace user-menu-and-account.md §6.
 */

import type { UiPreferences } from './api';

export const DEFAULT_PREFERENCES: UiPreferences = {
  accent: 'amber',
  theme: 'light',
  density: 'comfortable',
  motion: true,
  notif: { critical: true, email: true, maint: true, digest: false },
};

/** Swatch colors shown in Settings (must match the CSS data-accent sets). */
export const ACCENTS: { key: UiPreferences['accent']; color: string }[] = [
  { key: 'amber', color: '#ffa12e' },
  { key: 'aqua', color: '#35e0c8' },
  { key: 'blue', color: '#4dd0ff' },
  { key: 'violet', color: '#a78bfa' },
  { key: 'pink', color: '#ff6fae' },
  { key: 'green', color: '#3ddc84' },
];

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Lighten toward white — derives the "soft" accent from a custom hex. */
function soften(hex: string, t = 0.45): string {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c + (255 - c) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Reflect preferences onto the shell as data-attributes / CSS vars. */
export function applyPreferences(prefs: UiPreferences): void {
  const shell = document.querySelector<HTMLElement>('.portal-shell');
  if (!shell) return;

  if (prefs.accent.startsWith('#')) {
    // custom color: data-accent=custom + inline accent variables
    shell.setAttribute('data-accent', 'custom');
    shell.style.setProperty('--accent', prefs.accent);
    shell.style.setProperty('--accent-soft', soften(prefs.accent));
    shell.style.setProperty('--accent-rgb', hexToRgb(prefs.accent).join(', '));
  } else {
    shell.setAttribute('data-accent', prefs.accent);
    shell.style.removeProperty('--accent');
    shell.style.removeProperty('--accent-soft');
    shell.style.removeProperty('--accent-rgb');
  }

  shell.setAttribute('data-theme', prefs.theme);
  shell.setAttribute('data-density', prefs.density);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  shell.setAttribute('data-motion', prefs.motion && !reduced ? 'on' : 'off');
}
