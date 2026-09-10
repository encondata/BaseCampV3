/**
 * UI preferences — stored on the user's account (server-side), so every
 * device gets their normal display at login. This module only knows how
 * to APPLY preferences to the shell; persistence lives in AuthContext
 * (savePreferencesRequest). Ref: fibertrace user-menu-and-account.md §6.
 */

import { readableTextColor } from './color';
import type { UiPreferences } from './api';

export const DEFAULT_PREFERENCES: UiPreferences = {
  accent: 'amber',
  theme: 'light',
  density: 'comfortable',
  list_size: 'default',
  motion: true,
  nav_mode: 'expanded',
  nav_bg: 'default',
  nav_size: 'default',
  notif: { critical: true, email: true, maint: true, digest: false },
  list_prefs: {},
};

export type NavMode = UiPreferences['nav_mode'];

export const NAV_MODES: NavMode[] = ['expanded', 'rail', 'hidden'];

/** Cycles the sidebar mode: expanded -> rail -> hidden -> expanded. */
export function nextNavMode(mode: NavMode): NavMode {
  const idx = NAV_MODES.indexOf(mode);
  return NAV_MODES[(idx + 1) % NAV_MODES.length];
}

/** Sidebar background swatches shown in Settings (key = hex). */
export const NAV_BACKGROUNDS: { key: string; label: string; color: string }[] = [
  { key: '#1f2937', label: 'Slate', color: '#1f2937' },
  { key: '#0f2a4a', label: 'Navy', color: '#0f2a4a' },
  { key: '#0f2e25', label: 'Forest', color: '#0f2e25' },
  { key: '#2b1a3d', label: 'Plum', color: '#2b1a3d' },
  { key: '#18181b', label: 'Charcoal', color: '#18181b' },
  { key: '#f3f4f6', label: 'Paper', color: '#f3f4f6' },
];

/** Sidebar text-size scale factors, applied as --nav-scale. */
export const NAV_SCALE: Record<UiPreferences['nav_size'], number> = {
  small: 0.9,
  default: 1,
  large: 1.12,
  xlarge: 1.25,
};

/** Derives the sidebar palette from a custom background hex. */
export function navPalette(hex: string): { bg: string; fg: string; fgMute: string; line: string; hover: string } {
  const fg = readableTextColor(hex);
  const [r, g, b] = hexToRgb(fg);
  return {
    bg: hex,
    fg,
    fgMute: `rgba(${r}, ${g}, ${b}, 0.62)`,
    line: `rgba(${r}, ${g}, ${b}, 0.14)`,
    hover: `rgba(${r}, ${g}, ${b}, 0.07)`,
  };
}

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
  shell.setAttribute('data-list-size', prefs.list_size ?? 'default');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  shell.setAttribute('data-motion', prefs.motion && !reduced ? 'on' : 'off');

  const navMode = prefs.nav_mode ?? 'expanded';
  const navSize = prefs.nav_size ?? 'default';
  const navBg = prefs.nav_bg ?? 'default';
  shell.setAttribute('data-nav-mode', navMode);
  shell.setAttribute('data-nav-size', navSize);
  shell.style.setProperty('--nav-scale', String(NAV_SCALE[navSize]));

  if (navBg === 'default') {
    shell.setAttribute('data-nav-bg', 'default');
    shell.style.removeProperty('--nav-bg');
    shell.style.removeProperty('--nav-fg');
    shell.style.removeProperty('--nav-fg-mute');
    shell.style.removeProperty('--nav-line');
    shell.style.removeProperty('--nav-hover');
  } else {
    const palette = navPalette(navBg);
    shell.setAttribute('data-nav-bg', 'custom');
    shell.style.setProperty('--nav-bg', palette.bg);
    shell.style.setProperty('--nav-fg', palette.fg);
    shell.style.setProperty('--nav-fg-mute', palette.fgMute);
    shell.style.setProperty('--nav-line', palette.line);
    shell.style.setProperty('--nav-hover', palette.hover);
  }
}
