// @vitest-environment jsdom
/**
 * /people/workers — a worker's comma-separated trade renders as chips in the
 * Trade column and the detail panel, and the Trade column menu filters per
 * trade ("Cable, Hardware" is found under Cable and under Hardware).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';
import type { WorkerItem } from '../lib/workers';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    maxRank: 100,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const WORKERS = vi.hoisted(() => ({ rows: [] as unknown[] }));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string) => new Response(
    JSON.stringify(path === '/workers' ? WORKERS.rows : []), { status: 200 })),
  listWorkerStatuses: vi.fn(async () => []),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

// heavy children with their own fetching — not under test here
vi.mock('../components/AvatarUpload', () => ({ default: () => null }));
vi.mock('../components/workers/CertsPanel', () => ({ default: () => null }));

const { default: Workers } = await import('./Workers');

const worker = (over: Partial<WorkerItem>): WorkerItem => ({
  person_id: 'w1', display_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace',
  contact_email: null, phone: null, avatar_url: null, has_account: false,
  trade: null, level: null, status: 'active', status_label: 'Active',
  status_color: '#178a4c', status_note: null, partner: null, cert_count: 0, certs_expired: 0,
  ...over,
});

beforeEach(() => {
  WORKERS.rows = [
    worker({ person_id: 'w1', display_name: 'Ada Lovelace', trade: 'Cable, Hardware' }),
    worker({ person_id: 'w2', display_name: 'Grace Hopper', trade: 'Electrician' }),
    worker({ person_id: 'w3', display_name: 'Alan Turing', trade: null }),
  ];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = () => render(<MemoryRouter><Workers /></MemoryRouter>);

const rowOf = async (name: string) =>
  (await screen.findByText(name)).closest('.dir-row') as HTMLElement;

const chipTexts = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.chip.tag')).map((c) => c.textContent);

/** The Trade cell of a list row: .cell #1 is the name cell, #2 is Trade. */
const tradeCell = (row: HTMLElement) =>
  row.querySelectorAll('.row-main .cell')[1] as HTMLElement;

it('renders each trade as its own chip in the Trade cell, and a dash when empty', async () => {
  mount();
  expect(chipTexts(tradeCell(await rowOf('Ada Lovelace')))).toEqual(['Cable', 'Hardware']);
  expect(chipTexts(tradeCell(await rowOf('Grace Hopper')))).toEqual(['Electrician']);

  const blank = tradeCell(await rowOf('Alan Turing'));
  expect(chipTexts(blank)).toEqual([]);
  expect(blank.textContent).toBe('—');
});

it('the Trade column menu lists each trade separately and filters per trade', async () => {
  const user = userEvent.setup();
  mount();
  await rowOf('Ada Lovelace');

  await user.click(screen.getByRole('button', { name: 'Trade column menu' }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  expect(within(menu).getByText('Cable')).toBeDefined();
  expect(within(menu).getByText('Hardware')).toBeDefined();
  expect(within(menu).getByText('Electrician')).toBeDefined();
  expect(within(menu).queryByText('Cable, Hardware')).toBeNull();

  // every value starts checked and a click unchecks it: uncheck all but Hardware
  await user.click(within(menu).getByText('Cable'));
  await user.click(within(menu).getByText('Electrician'));
  await user.click(within(menu).getByText('—'));
  await waitFor(() => expect(screen.queryByText('Grace Hopper')).toBeNull());
  expect(screen.getByText('Ada Lovelace')).toBeDefined();
  expect(screen.queryByText('Alan Turing')).toBeNull();
});

it('the detail panel shows the trade as chips', async () => {
  const user = userEvent.setup();
  mount();
  const row = await rowOf('Ada Lovelace');
  await user.click(row.querySelector('.row-main') as HTMLElement);

  const dd = await waitFor(() => {
    const dt = Array.from(row.querySelectorAll('.detail dt')).find((d) => d.textContent === 'Trade');
    expect(dt).toBeTruthy();
    return dt!.nextElementSibling as HTMLElement;
  });
  expect(chipTexts(dd)).toEqual(['Cable', 'Hardware']);
});

it('Edit profile offers the distinct trades across all workers, naturally sorted', async () => {
  const user = userEvent.setup();
  WORKERS.rows = [
    worker({ person_id: 'w1', display_name: 'Ada Lovelace', trade: 'Cable, hardware' }),
    worker({ person_id: 'w2', display_name: 'Grace Hopper', trade: 'Hardware, Rack 10, Rack 2' }),
    worker({ person_id: 'w3', display_name: 'Alan Turing', trade: null }),
  ];
  mount();
  const row = await rowOf('Ada Lovelace');
  await user.click(row.querySelector('.row-main') as HTMLElement);
  await user.click(await within(row).findByRole('button', { name: /Edit profile/ }));

  // focus the (empty) trade input: every distinct trade not already a chip is offered
  await user.click(row.querySelector('.tag-input-field') as HTMLElement);
  const offered = Array.from(document.querySelectorAll('.combo-menu .kbar-item'))
    .map((b) => b.textContent);
  // "hardware" is already a chip on Ada, "Hardware" (Grace) dedupes against it
  expect(offered).toEqual(['Rack 2', 'Rack 10']);
});
