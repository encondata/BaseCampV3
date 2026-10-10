// @vitest-environment jsdom
/**
 * /stakeholders/clients (OrgDirectory) — narrow regression coverage for
 * security-fixes task 11b: `Organization.notes` is staff-internal (the
 * API nulls it on read and refuses a PATCH naming it with 403
 * notes_internal for any non-global actor), so the Edit modal must hide
 * the Notes field and leave `notes` out of the PATCH body for a scoped
 * client/vendor contact — otherwise their every edit would 403. Global
 * staff keep the field and still send it.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';
import type { OrgItem } from '../lib/orgs';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => ({ global: true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    scope: { global: auth.global, client_ids: auth.global ? [] : ['c1'], partner_ids: [] },
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listPartnerTypes: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: OrgDirectory } = await import('./OrgDirectory');

const ORG: OrgItem = {
  id: 'c1', name: 'Acme', code: null, partner_types: [], status: 'active',
  tier: 'preferred', service_region: null, phone: null, website: null,
  address_line1: null, address_line2: null, city: null, region: null,
  postal_code: null, country: 'US', notes: null,
  account_manager: null, contact_count: 0, logo_url: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  api.listPartnerTypes.mockResolvedValue([]);
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/clients' && !init?.method) return jsonResponse([ORG]);
    if (path === '/clients/c1/contacts') return jsonResponse([]);
    if (path === '/people') return jsonResponse([]);
    if (path === '/clients/c1' && init?.method === 'PATCH') return jsonResponse(ORG);
    return jsonResponse({ code: 'unexpected' }, 500);
  });
});

afterEach(cleanup);

async function openEditModal() {
  render(
    <MemoryRouter>
      <OrgDirectory cfg={{
        kind: 'client', apiBase: '/clients', title: 'Clients', blurb: '',
        addLabel: 'Add client', hasType: false,
      }} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelector('.dir-row .row-main')).not.toBeNull());
  fireEvent.click(document.querySelector('.dir-row .row-main') as HTMLElement);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit client' }));
  await screen.findByRole('heading', { name: 'Edit Acme' });
  // scope to the modal — the expanded row's detail list and the column
  // picker also render the word "Notes"
  return within(document.querySelector('.modal-card') as HTMLElement);
}

function patchCall() {
  return api.apiFetch.mock.calls.find(
    ([path, init]) => path === '/clients/c1' && (init as RequestInit | undefined)?.method === 'PATCH');
}

function patchBody(): Record<string, unknown> {
  const call = patchCall();
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

it('scoped (non-global) contact: Edit modal has no Notes field and the PATCH omits notes', async () => {
  auth.global = false;
  const modal = await openEditModal();

  expect(modal.queryByText('Notes')).toBeNull();
  expect(modal.getByText('Phone')).not.toBeNull();   // the modal did render its fields

  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(patchCall()).toBeDefined());
  const body = patchBody();
  expect('notes' in body).toBe(false);
  expect(body.name).toBe('Acme');   // the rest of the payload is intact
});

it('global staff: Edit modal keeps the Notes field and the PATCH sends notes', async () => {
  auth.global = true;
  const modal = await openEditModal();

  const notes = modal.getByText('Notes').parentElement!.querySelector('input') as HTMLInputElement;
  expect(notes).not.toBeNull();
  fireEvent.change(notes, { target: { value: 'late payer' } });

  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(patchCall()).toBeDefined());
  expect(patchBody().notes).toBe('late payer');
});

it('Clients list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(
    <MemoryRouter>
      <OrgDirectory cfg={{
        kind: 'client', apiBase: '/clients', title: 'Clients', blurb: '',
        addLabel: 'Add client', hasType: false,
      }} />
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Acme')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

/* ── Partners: parent partner ───────────────────────────────────────── */

const partner = (over: Partial<OrgItem>): OrgItem => ({
  ...ORG, tier: null, service_region: null, parent_id: null, parent_name: null, child_count: 0,
  ...over,
});
// Zeta > Mid > Leaf is a three-level chain; Other is unrelated.
const P_ZETA = partner({ id: 'pz', name: 'Zeta Holdings', child_count: 1 });
const P_MID = partner({
  id: 'pm', name: 'Mid Logistics', parent_id: 'pz', parent_name: 'Zeta Holdings', child_count: 1,
});
const P_LEAF = partner({ id: 'pl', name: 'Leaf Cable', parent_id: 'pm', parent_name: 'Mid Logistics' });
const P_OTHER = partner({ id: 'po', name: 'Other Staffing' });
const PARTNERS = [P_ZETA, P_MID, P_LEAF, P_OTHER];

const PARTNER_CFG = {
  kind: 'partner' as const, apiBase: '/partners', title: 'Partners', blurb: '',
  addLabel: 'Add partner', hasType: true,
};

function mockPartnerApi() {
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/partners' && !init?.method) return jsonResponse(PARTNERS);
    if (path === '/partners' && init?.method === 'POST') return jsonResponse(P_OTHER);
    if (/^\/partners\/[a-z]+\/contacts$/.test(path)) return jsonResponse([]);
    if (/^\/partners\/[a-z]+\/workers$/.test(path)) return jsonResponse([]);
    if (path === '/people') return jsonResponse([]);
    if (/^\/partners\/[a-z]+$/.test(path) && init?.method === 'PATCH') return jsonResponse(P_MID);
    return jsonResponse({ code: 'unexpected' }, 500);
  });
}

function renderPartners() {
  render(
    <MemoryRouter>
      <OrgDirectory cfg={PARTNER_CFG} />
    </MemoryRouter>,
  );
}

async function openPartnerEdit(name: string) {
  renderPartners();
  const row = (await screen.findByText(name)).closest('.dir-row') as HTMLElement;
  fireEvent.click(row.querySelector('.row-main') as HTMLElement);
  fireEvent.click(await within(row).findByRole('button', { name: 'Edit partner' }));
  await screen.findByRole('heading', { name: `Edit ${name}` });
  return within(document.querySelector('.modal-card') as HTMLElement);
}

function partnerPatchBody(id: string): Record<string, unknown> {
  const call = api.apiFetch.mock.calls.find(
    ([path, init]) => path === `/partners/${id}` && (init as RequestInit | undefined)?.method === 'PATCH');
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

/** The Parent partner ComboBox's input, and the labels of the options it lists. */
function parentCombo(modal: ReturnType<typeof within>) {
  const input = modal.getByText('Parent partner').parentElement!
    .querySelector('input') as HTMLInputElement;
  expect(input).not.toBeNull();
  return input;
}
function openOptions(input: HTMLInputElement): string[] {
  fireEvent.focus(input);
  return [...document.querySelectorAll('.combo-menu .kbar-item')]
    .map((b) => (b.firstChild?.textContent ?? '').trim());
}

it('partner edit (staff): Parent partner options exclude the partner and its descendants, plus None', async () => {
  auth.global = true;
  mockPartnerApi();
  const modal = await openPartnerEdit('Zeta Holdings');
  const labels = openOptions(parentCombo(modal));
  // Zeta's descendants are Mid and Leaf; itself is excluded too
  expect(labels).toEqual(['None', 'Other Staffing']);
});

it('partner edit (staff): a mid-chain partner may not pick its own descendant', async () => {
  auth.global = true;
  mockPartnerApi();
  const modal = await openPartnerEdit('Mid Logistics');
  const labels = openOptions(parentCombo(modal));
  expect(labels).toContain('Zeta Holdings');
  expect(labels).toContain('Other Staffing');
  expect(labels).not.toContain('Mid Logistics');
  expect(labels).not.toContain('Leaf Cable');
});

it('partner edit (staff): saving without touching the parent never sends parent_id', async () => {
  auth.global = true;
  mockPartnerApi();
  const modal = await openPartnerEdit('Mid Logistics');
  // the field shows the current parent
  expect(parentCombo(modal).value).toBe('Zeta Holdings');
  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.apiFetch.mock.calls.some(
    ([p, i]) => p === '/partners/pm' && (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
  expect('parent_id' in partnerPatchBody('pm')).toBe(false);
});

it('partner edit (staff): picking a parent sends parent_id; None sends null', async () => {
  auth.global = true;
  mockPartnerApi();
  let modal = await openPartnerEdit('Leaf Cable');
  openOptions(parentCombo(modal));
  fireEvent.mouseDown(screen.getByRole('button', { name: /Other Staffing/ }));
  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(partnerPatchBody('pl').parent_id).toBe('po'));

  cleanup();
  vi.clearAllMocks();
  mockPartnerApi();
  modal = await openPartnerEdit('Leaf Cable');
  openOptions(parentCombo(modal));
  fireEvent.mouseDown(screen.getByRole('button', { name: 'None' }));
  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(partnerPatchBody('pl').parent_id).toBeNull());
});

it('partner create (staff): parent_id is sent only when a parent was picked', async () => {
  auth.global = true;
  mockPartnerApi();
  renderPartners();
  await screen.findByText('Zeta Holdings');
  fireEvent.click(screen.getByRole('button', { name: '+ Add partner' }));
  let modal = within(document.querySelector('.modal-card') as HTMLElement);
  fireEvent.change(modal.getByText('Name *').parentElement!.querySelector('input')!,
    { target: { value: 'Fresh Co' } });
  fireEvent.click(modal.getByRole('button', { name: 'Create partner' }));
  const post = () => api.apiFetch.mock.calls.find(
    ([p, i]) => p === '/partners' && (i as RequestInit | undefined)?.method === 'POST');
  await waitFor(() => expect(post()).toBeDefined());
  expect('parent_id' in JSON.parse((post()![1] as RequestInit).body as string)).toBe(false);

  cleanup();
  vi.clearAllMocks();
  mockPartnerApi();
  renderPartners();
  await screen.findByText('Zeta Holdings');
  fireEvent.click(screen.getByRole('button', { name: '+ Add partner' }));
  modal = within(document.querySelector('.modal-card') as HTMLElement);
  fireEvent.change(modal.getByText('Name *').parentElement!.querySelector('input')!,
    { target: { value: 'Fresh Co' } });
  openOptions(parentCombo(modal));
  fireEvent.mouseDown(screen.getByRole('button', { name: /Zeta Holdings/ }));
  fireEvent.click(modal.getByRole('button', { name: 'Create partner' }));
  await waitFor(() => expect(post()).toBeDefined());
  expect(JSON.parse((post()![1] as RequestInit).body as string).parent_id).toBe('pz');
});

it('partner edit (partner-scoped user): no Parent partner field and no parent_id sent', async () => {
  auth.global = false;
  mockPartnerApi();
  const modal = await openPartnerEdit('Mid Logistics');
  expect(modal.queryByText('Parent partner')).toBeNull();
  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.apiFetch.mock.calls.some(
    ([p, i]) => p === '/partners/pm' && (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
  expect('parent_id' in partnerPatchBody('pm')).toBe(false);
});

it('partner edit: a parent_id 422 shows its message', async () => {
  auth.global = true;
  mockPartnerApi();
  const base = api.apiFetch.getMockImplementation()!;
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    path === '/partners/pl' && init?.method === 'PATCH'
      ? jsonResponse({ detail: { code: 'circular_parent' } }, 422)
      : base(path, init));
  const modal = await openPartnerEdit('Leaf Cable');
  openOptions(parentCombo(modal));
  fireEvent.mouseDown(screen.getByRole('button', { name: /Other Staffing/ }));
  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  expect(await modal.findByText('That would make a partner its own ancestor.')).not.toBeNull();
});

async function showParentColumn() {
  renderPartners();
  await screen.findByText('Zeta Holdings');
  // off by default
  expect(document.querySelector('.list-head')!.textContent).not.toContain('Parent');
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
  fireEvent.click(screen.getByRole('button', { name: /^Parent/ }));
}

it('Partners list: Parent column is off by default, shows the parent name, and sorts naturally', async () => {
  auth.global = true;
  mockPartnerApi();
  await showParentColumn();
  const head = document.querySelector('.list-head') as HTMLElement;
  expect(head.textContent).toContain('Parent');
  const rowFor = (n: string) => screen.getByText(n).closest('.dir-row') as HTMLElement;
  expect(rowFor('Leaf Cable').textContent).toContain('Mid Logistics');
  expect(rowFor('Other Staffing').querySelector('.row-main')!.textContent).toContain('—');
  // sort by Parent ascending (click the header label)
  fireEvent.click(within(head).getByRole('button', { name: /^Parent\s*$/ }));
  const names = [...document.querySelectorAll('.dir-row .pn b')].map((b) => b.textContent);
  // "—" rows (empty parent) first, then Mid Logistics (Leaf), then Zeta Holdings (Mid)
  expect(names.slice(-2)).toEqual(['Leaf Cable', 'Mid Logistics']);
});

it('Partners list: Parent column filters through the column menu', async () => {
  auth.global = true;
  mockPartnerApi();
  await showParentColumn();
  fireEvent.click(screen.getByRole('button', { name: 'Parent column menu' }));
  fireEvent.change(await screen.findByPlaceholderText('Filter Parent'), { target: { value: 'mid' } });
  await waitFor(() => expect(screen.queryByText('Other Staffing')).toBeNull());
  expect(screen.getByText('Leaf Cable')).not.toBeNull();
});

it('Clients list has no Parent column option', async () => {
  auth.global = true;
  render(
    <MemoryRouter>
      <OrgDirectory cfg={{
        kind: 'client', apiBase: '/clients', title: 'Clients', blurb: '',
        addLabel: 'Add client', hasType: false,
      }} />
    </MemoryRouter>,
  );
  await screen.findByText('Acme');
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
  expect(screen.queryByRole('button', { name: /^Parent/ })).toBeNull();
});
