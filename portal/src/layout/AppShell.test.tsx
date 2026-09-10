// @vitest-environment jsdom
/**
 * The nav-filtering wiring. lib/godmode.test.ts already covers
 * isNavItemVisible in isolation and pins `godOnly: true` on the Variables
 * item; what is asserted here is that AppShell actually routes every nav item
 * through that gate, which no unit test can see. Also covers the
 * collapsible-nav shell: rail/hidden modes, the flyout, the hidden-mode
 * overlay, the collapse toggle, and the Ctrl/⌘+B shortcut.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action: 'view') => boolean;
    godMode: boolean;
    navMode: UiPreferences['nav_mode'];
    updatePreferences: (prefs: UiPreferences) => Promise<boolean>;
  } = {
    can: () => true,
    godMode: false,
    navMode: 'expanded',
    updatePreferences: vi.fn(async () => true),
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
      nav_mode: auth.navMode,
      nav_bg: 'default',
      nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: auth.updatePreferences,
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

/** A stub matchMedia — jsdom implements none. `matches` is fixed per test;
 *  applyPreferences (unrelated `prefers-reduced-motion` query) and
 *  AppShell's own `(max-width: 900px)` query share this one stub, so tests
 *  that care about the breakpoint pass `matches: true` explicitly. */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  auth.can = () => true;
  auth.godMode = false;
  auth.navMode = 'expanded';
  auth.updatePreferences = vi.fn(async () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell(children: ReactNode = 'content') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppShell>{children}</AppShell>
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

it('expanded mode renders nav item labels', () => {
  auth.navMode = 'expanded';

  renderShell();

  // scoped to the docked nav — the topbar crumb for "/" also reads
  // "Main Dashboard", so an unscoped query would see two matches.
  const nav = within(document.querySelector('.portal-nav.docked')!);
  expect(nav.getByText('Main Dashboard')).toBeDefined();
  expect(nav.getByText('Move Dashboard')).toBeDefined();
});

it('rail mode renders section icon buttons and opens/closes a flyout on click, navigating on link click', () => {
  auth.navMode = 'rail';

  renderShell();

  // no item labels docked until a section's flyout is opened
  expect(screen.queryByText('Move Dashboard')).toBeNull();

  const sectionButton = screen.getByRole('button', { name: 'Dashboards' });
  expect(sectionButton).toBeDefined();

  fireEvent.click(sectionButton);
  expect(screen.getByText('Move Dashboard')).toBeDefined();

  // navigating changes the topbar crumb to "Move Dashboard" too, so assert
  // on the flyout container closing rather than the (now ambiguous) text.
  fireEvent.click(screen.getByText('Move Dashboard'));
  expect(document.querySelector('.nav-flyout')).toBeNull();
});

it('hidden mode renders the hamburger and no docked links; opening the overlay shows them; Escape closes it', () => {
  auth.navMode = 'hidden';

  renderShell();

  expect(screen.queryByText('Move Dashboard')).toBeNull();
  const hamburger = screen.getByRole('button', { name: 'Open navigation' });

  fireEvent.click(hamburger);
  expect(screen.getByText('Move Dashboard')).toBeDefined();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByText('Move Dashboard')).toBeNull();
});

it('the collapse toggle calls updatePreferences with the next nav mode', () => {
  auth.navMode = 'expanded';

  renderShell();

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

  expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_mode: 'rail' }),
  );
});

it('Ctrl+B cycles the nav mode', () => {
  auth.navMode = 'expanded';

  renderShell();

  fireEvent.keyDown(document, { key: 'b', ctrlKey: true });

  expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_mode: 'rail' }),
  );
});

it('Ctrl+B is ignored while typing in an input', () => {
  auth.navMode = 'expanded';

  renderShell(<input data-testid="typing-target" />);
  const input = screen.getByTestId('typing-target');

  fireEvent.keyDown(input, { key: 'b', ctrlKey: true });

  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

it('toggling from expanded (with a section open) into rail clears openSection — the flyout does not auto-open, only a section-icon click opens it', () => {
  auth.navMode = 'expanded';
  // the real AuthContext re-renders AppShell with the updated preference
  // once updatePreferences resolves; simulate that by having the mock
  // mutate the hoisted, mutable `auth.navMode` itself.
  auth.updatePreferences = vi.fn(async (prefs: UiPreferences) => {
    auth.navMode = prefs.nav_mode;
    return true;
  });

  const { rerender } = renderShell();

  // starting expanded at '/', the Dashboards section (which contains "/")
  // is open in the docked accordion
  const nav = within(document.querySelector('.portal-nav.docked')!);
  expect(nav.getByText('Move Dashboard')).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(auth.navMode).toBe('rail');

  rerender(
    <MemoryRouter initialEntries={['/']}>
      <AppShell>content</AppShell>
    </MemoryRouter>,
  );

  // now in rail mode — no flyout should have auto-opened just because the
  // mode changed while a section was open in the accordion
  expect(document.querySelector('.nav-flyout')).toBeNull();

  // clicking a section icon is still the only thing that opens the flyout
  fireEvent.click(screen.getByRole('button', { name: 'Dashboards' }));
  expect(document.querySelector('.nav-flyout')).not.toBeNull();
  expect(screen.getByText('Move Dashboard')).toBeDefined();
});

it('a matchMedia match at <=900px forces hidden mode even when the preference is expanded', () => {
  auth.navMode = 'expanded';
  stubMatchMedia(true);

  renderShell();

  expect(screen.getByRole('button', { name: 'Open navigation' })).toBeDefined();
  expect(screen.queryByText('Move Dashboard')).toBeNull();
});
