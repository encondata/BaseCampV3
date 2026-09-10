// @vitest-environment jsdom
/**
 * The nav-filtering wiring. lib/godmode.test.ts already covers
 * isNavItemVisible in isolation and pins `godOnly: true` on the Variables
 * item; what is asserted here is that AppShell actually routes every nav item
 * through that gate, which no unit test can see.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: 'view') => boolean; godMode: boolean } = {
    can: () => true,
    godMode: false,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Ada Lovelace' },
    roles: ['developer'],
    logout: vi.fn(),
    preferences: {
      accent: 'blue',
      theme: 'dark',
      density: 'comfortable',
      list_size: 'default',
      motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    can: auth.can,
    godMode: auth.godMode,
    godNavColor: '#ff00ff',
    exitGodMode: vi.fn(),
    scope: { global: true, client_ids: [], partner_ids: [] },
  }),
}));

// CommandPalette fetches /users on mount; the shell is not the subject here.
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
  unlockGodMode: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  onSystemStatusRefresh: vi.fn(() => () => {}),
}));

vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hello' },
    refresh: vi.fn(),
  }),
}));

beforeEach(() => {
  // jsdom implements no matchMedia; applyPreferences reads it on mount.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  auth.can = () => true;
  auth.godMode = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppShell>content</AppShell>
    </MemoryRouter>,
  );
}

const { default: AppShell } = await import('./AppShell');

it('hides a godOnly item from a permitted user who has not unlocked god mode', () => {
  auth.can = () => true;
  auth.godMode = false;

  renderShell();

  expect(screen.queryByText('Variables')).toBeNull();
});

it('reveals a godOnly item once god mode is unlocked', () => {
  auth.can = () => true;
  auth.godMode = true;

  renderShell();

  expect(screen.getByText('Variables')).toBeDefined();
});

it('hides an item the user cannot view even in god mode', () => {
  auth.can = (resource) => resource !== 'devtools';
  auth.godMode = true;

  renderShell();

  expect(screen.queryByText('Variables')).toBeNull();
});

it('renders the system banners above the topbar', () => {
  renderShell();
  const col = document.querySelector('.portal-main-col')!;
  const first = col.firstElementChild!;
  expect(first.className).toContain('sys-banner-readonly');
  expect(screen.getByText('Hello').className).toContain('sys-banner-broadcast');
});
