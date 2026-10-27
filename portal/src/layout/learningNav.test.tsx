// @vitest-environment jsdom
/**
 * The Learning nav section: where it sits, what it holds, and who sees it.
 * Managers are `learning:view` OR a global role holding `wiki:delete` (the
 * API's is_manager), so a wiki administrator with no learning permission
 * still gets it and a worker never does.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { isNavItemVisible } from '../lib/godmode';
import { NAV_SECTIONS } from './navSections';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action?: string) => boolean;
    global: boolean;
  } = { can: () => true, global: true };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Ada Lovelace' },
    roles: [],
    logout: vi.fn(),
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      list_view: 'expanded',
      notif: { sound: 'chime', categories: {} }, list_prefs: {},
    },
    updatePreferences: vi.fn(async () => true),
    can: auth.can,
    godMode: false,
    godNavColor: null,
    exitGodMode: vi.fn(),
    maxRank: 100,
    scope: { global: auth.global, client_ids: [], partner_ids: [] },
  }),
}));

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
  unlockGodMode: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  onSystemStatusRefresh: vi.fn(() => () => {}),
}));

vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: false, read_only_message: '', workers_paused: false, banner: null },
    refresh: vi.fn(),
  }),
}));

const { default: AppShell } = await import('./AppShell');

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  auth.can = () => true;
  auth.global = true;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const section = () => NAV_SECTIONS.find((s) => s.label === 'Learning')!;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>content</AppShell>
    </MemoryRouter>,
  );
}

it('sits right after People with the five items in order', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  expect(labels[labels.indexOf('People') + 1]).toBe('Learning');
  expect(section().items.map((i) => [i.label, i.to])).toEqual([
    ['Dashboard', '/learning'],
    ['Library', '/learning/library'],
    ['Packets', '/learning/packets'],
    ['Assignment rules', '/learning/rules'],
    ['Settings', '/learning/settings'],
  ]);
  expect(section().items[0].end).toBe(true);
  expect(section().items.every((i) => i.resource === 'learning')).toBe(true);
});

const learningAdmin = (resource: string) => resource === 'learning';
const wikiAdmin = (resource: string, action = 'view') =>
  resource === 'wiki' && (action === 'view' || action === 'delete');
const worker = () => false;

it('shows every item to a learning admin, a global wiki admin, and nobody else', () => {
  for (const item of section().items) {
    expect(isNavItemVisible(item, learningAdmin, false, 60, true)).toBe(true);
    expect(isNavItemVisible(item, wikiAdmin, false, 60, true)).toBe(true);
    expect(isNavItemVisible(item, worker, false, 5, false)).toBe(false);
  }
});

it('hides it from a wiki admin whose role is client- or partner-anchored', () => {
  for (const item of section().items) {
    expect(isNavItemVisible(item, wikiAdmin, false, 60, false)).toBe(false);
  }
});

it('renders the Learning section in the shell for a learning admin', () => {
  auth.can = learningAdmin;
  renderAt('/learning');
  expect(screen.getByText('Learning')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/learning');
});

it('renders it for a wiki admin without the learning resource', () => {
  auth.can = wikiAdmin;
  renderAt('/learning');
  expect(screen.getByRole('link', { name: 'Library' }).getAttribute('href'))
    .toBe('/learning/library');
});

it('omits it for a worker', () => {
  auth.can = worker;
  auth.global = false;
  renderAt('/');
  expect(screen.queryByText('Learning')).toBeNull();
});
