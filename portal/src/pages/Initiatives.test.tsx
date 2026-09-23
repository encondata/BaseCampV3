// @vitest-environment jsdom
/**
 * /initiatives — the nested tree rows. The flattening itself is covered by
 * lib/initiatives.test.ts (buildInitiativeTree); this covers what the page
 * adds on top: the indent custom property, the chevron button and its
 * child count, the role chip on a child, dimmed context ancestors that a
 * search pulls in (chevronless and inert — the builder force-expands them
 * and there is nothing to open), the non-context result count, and the
 * deep link that opens a branch instead of giving up on its target —
 * where an ordinary click on a row is not a deep link and must not undo
 * the collapse the user asks for next.
 *
 * Generic toolbar/column-menu/CSV behavior is covered by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, UiPreferences } from '../lib/api';
import { COLLAPSED_KEY } from '../lib/initiatives';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    maxRank: 90,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listInitiativeStatuses: vi.fn(),
  listInitiativeTypes: vi.fn(),
  listInitiativeSubTypes: vi.fn(),
  listInitiativeWorkTypes: vi.fn(),
  listShippingTypes: vi.fn(),
  listSites: vi.fn(),
  listClients: vi.fn(),
  listPartners: vi.fn(),
  listWorkerOptions: vi.fn(),
  getInitiative: vi.fn(),
  listNotes: vi.fn(),
  listAttachments: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function initiative(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'Denver DC migration', description: null,
    initiative_type: 'project', type_label: 'Project', type_color: '#1668a7',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'scheduled', status_label: 'Scheduled', status_color: '#1668a7',
    color: null,
    client_id: 'c1', client_name: 'Acme',
    site_id: 's1', site_name: 'DC-East', location: null,
    scheduled_start: '2026-09-05', scheduled_end: '2026-09-10',
    sky_command_project_id: null,
    origin_site_id: null, origin_site_name: null,
    destination_site_id: null, destination_site_name: null,
    real_start_at: null, real_end_at: null,
    priority_devices: null, shipping_types: [],
    shipping_partner_id: null, shipping_partner_name: null,
    origin_tech_partner_id: null, origin_cable_partner_id: null,
    origin_logistics_partner_id: null,
    destination_tech_partner_id: null, destination_cable_partner_id: null,
    destination_logistics_partner_id: null,
    origin_vendor_involved: null, destination_vendor_involved: null,
    people_count: 0, links_count: 0,
    parent_id: null, parent_role: null,
    archived_at: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** The dev-DB shape this task exists for: a project with one event under it. */
const PARENT = initiative({ id: 'p1', name: 'Denver DC migration' });
const CHILD = initiative({
  id: 'e1', name: 'Kickoff walkthrough',
  initiative_type: 'event', type_label: 'Event',
  parent_id: 'p1', parent_role: 'Event 1',
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // the collapsed set persists here — isolate each test
  api.listInitiatives.mockResolvedValue([PARENT, CHILD]);
  api.listInitiativeStatuses.mockResolvedValue([]);
  api.listInitiativeTypes.mockResolvedValue([]);
  api.listInitiativeSubTypes.mockResolvedValue([]);
  api.listInitiativeWorkTypes.mockResolvedValue([]);
  api.listShippingTypes.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
  api.listClients.mockResolvedValue([]);
  api.listPartners.mockResolvedValue([]);
  api.listWorkerOptions.mockResolvedValue([]);
  api.getInitiative.mockResolvedValue({
    ...PARENT, people: [], links_children: [], links_parents: [],
  });
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: Initiatives } = await import('./Initiatives');

const mount = (state?: { openRow: string }) => render(
  <MemoryRouter initialEntries={[{ pathname: '/initiatives', state: state ?? null }]}>
    <Initiatives />
  </MemoryRouter>,
);

const rowEls = () =>
  Array.from(document.querySelectorAll('.dir-row')) as HTMLElement[];
const rowNames = () =>
  rowEls().map((r) => r.querySelector('.cell-primary .pn b')?.textContent ?? '');
const rowFor = (name: string) =>
  rowEls().find((r) => r.querySelector('.cell-primary .pn b')?.textContent === name)!;
const chevronIn = (row: HTMLElement) =>
  row.querySelector('.row-main button[aria-expanded]') as HTMLButtonElement | null;

it('renders a child indented under its parent, with the role chip and a parent count', async () => {
  mount();
  await waitFor(() => expect(rowNames()).toEqual(
    ['Denver DC migration', 'Kickoff walkthrough']));

  const parent = rowFor('Denver DC migration');
  const child = rowFor('Kickoff walkthrough');
  expect(parent.style.getPropertyValue('--depth')).toBe('0');
  expect(child.style.getPropertyValue('--depth')).toBe('1');

  // the link's role reads as a chip after the child's name, parent-side only
  const chip = child.querySelector('.cell-primary .chip.c-slate');
  expect(chip?.textContent).toBe('Event 1');
  expect(parent.querySelector('.cell-primary .chip.c-slate')).toBeNull();

  const toggle = chevronIn(parent)!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-label')).toBe('Collapse');
  expect(toggle.textContent).toContain('1');
  // a leaf never offers a chevron, however "expanded" the builder calls it
  expect(chevronIn(child)).toBeNull();
});

it('the chevron collapses and re-expands the branch, persisting the collapsed set', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.click(chevronIn(rowFor('Denver DC migration'))!);
  await waitFor(() => expect(rowNames()).toEqual(['Denver DC migration']));
  const toggle = chevronIn(rowFor('Denver DC migration'))!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-label')).toBe('Expand');
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual(['p1']);

  await user.click(chevronIn(rowFor('Denver DC migration'))!);
  await waitFor(() => expect(rowNames()).toEqual(
    ['Denver DC migration', 'Kickoff walkthrough']));
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual([]);
});

it('a search matching only the child keeps the parent as an uncounted context row', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Kickoff');
  await waitFor(() => expect(rowNames()).toEqual(
    ['Denver DC migration', 'Kickoff walkthrough']));

  expect(rowFor('Denver DC migration').classList.contains('context')).toBe(true);
  expect(rowFor('Kickoff walkthrough').classList.contains('context')).toBe(false);
  // the ancestor is scaffolding, not a result
  expect(screen.getByText('1 of 2 shown')).not.toBeNull();
});

it('clicking the chevron does not open the row detail', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.click(chevronIn(rowFor('Denver DC migration'))!);
  await waitFor(() => expect(rowNames()).toEqual(['Denver DC migration']));
  expect(document.querySelector('.dir-row.open')).toBeNull();
  expect(api.getInitiative).not.toHaveBeenCalled();
});

it('a deep link under a collapsed parent expands the branch instead of dropping the row', async () => {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['p1']));
  mount({ openRow: 'e1' });

  await waitFor(() => expect(rowNames()).toEqual(
    ['Denver DC migration', 'Kickoff walkthrough']));
  expect(rowFor('Kickoff walkthrough').classList.contains('open')).toBe(true);
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual([]);
});

it('collapsing a parent whose child is open leaves the branch collapsed', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  // opening a row by clicking it is not a deep link — nothing may treat it
  // as one and undo the collapse the user asks for next
  await user.click(rowFor('Kickoff walkthrough').querySelector('.row-main')!);
  await waitFor(() => expect(
    rowFor('Kickoff walkthrough').classList.contains('open')).toBe(true));

  await user.click(chevronIn(rowFor('Denver DC migration'))!);
  await waitFor(() => expect(rowNames()).toEqual(['Denver DC migration']));
  expect(chevronIn(rowFor('Denver DC migration'))!.getAttribute('aria-expanded'))
    .toBe('false');
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual(['p1']);
});

it('a context row offers no chevron — the builder force-expands it anyway', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Kickoff');
  await waitFor(() => expect(
    rowFor('Denver DC migration').classList.contains('context')).toBe(true));

  // a chevron here would leave the subtree open and still write the id to
  // the shared collapsed set, shutting the branch later and on the timeline
  expect(chevronIn(rowFor('Denver DC migration'))).toBeNull();
  expect(chevronIn(rowFor('Kickoff walkthrough'))).toBeNull();
});

it('clicking a context row does not open its detail', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Kickoff');
  await waitFor(() => expect(
    rowFor('Denver DC migration').classList.contains('context')).toBe(true));

  await user.click(rowFor('Denver DC migration').querySelector('.row-main')!);
  expect(document.querySelector('.dir-row.open')).toBeNull();
  expect(api.getInitiative).not.toHaveBeenCalled();
});

it('a filter that turns an open row into context closes its detail', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  await user.click(rowFor('Denver DC migration').querySelector('.row-main')!);
  await waitFor(() => expect(
    rowFor('Denver DC migration').classList.contains('open')).toBe(true));

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Kickoff');
  await waitFor(() => expect(
    rowFor('Denver DC migration').classList.contains('context')).toBe(true));
  // a full-opacity detail panel under a 0.55-opacity header would be a lie
  expect(document.querySelector('.dir-row.open')).toBeNull();
});

it('initiatives: column floors, shared template + minimum, sideways-scroll card', async () => {
  mount();
  await waitFor(() => expect(rowNames()).toHaveLength(2));

  const row = rowFor('Denver DC migration');
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(1176);
});
