// @vitest-environment jsdom
/**
 * /stakeholders/clients/:id and /partners/:id — the Full Details page.
 * Narrow regression coverage for security-fixes task 7: a bad (non-http)
 * `website` value must render as plain text, never as a clickable anchor
 * — the API normalizes/validates on write, but this is the independent
 * render-time guard (lib/safeHref) in case a stored value predates that
 * or reached storage some other way.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ContactItem, InitiativeItem, UiPreferences } from '../lib/api';
import type { OrgItem } from '../lib/orgs';
import type { WorkerItem } from '../lib/workers';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => ({ global: true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    scope: { global: auth.global, client_ids: [], partner_ids: auth.global ? [] : ['pt1'] },
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
  getOrg: vi.fn(),
  listInitiatives: vi.fn(),
  listOrgContacts: vi.fn(),
  listPartnerTypes: vi.fn(),
  listPartnerWorkers: vi.fn(),
  listPartnerChildren: vi.fn(),
  listPartnerItems: vi.fn(),
  setPartnerParent: vi.fn(),
}));

const partnerOrg = (over: Partial<OrgItem> = {}): OrgItem => ({
  id: 'pt1', name: 'Acme Logistics', code: null, partner_types: [], status: 'active',
  tier: null, service_region: null, phone: null,
  website: null,
  address_line1: null, address_line2: null, city: null, region: null,
  postal_code: null, country: 'US', notes: null,
  account_manager: null, contact_count: 0, logo_url: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

function renderPartnerPage() {
  render(
    <MemoryRouter initialEntries={['/stakeholders/partners/pt1']}>
      <Routes>
        <Route path="/stakeholders/partners/:id" element={<StakeholderDetail kind="partner" />} />
      </Routes>
    </MemoryRouter>,
  );
}

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: StakeholderDetail } = await import('./StakeholderDetail');

const org = (over: Partial<OrgItem> = {}): OrgItem => ({
  id: 'c1', name: 'Acme', code: null, partner_types: [], status: 'active',
  tier: 'preferred', service_region: null, phone: null,
  website: 'https://acme.example',
  address_line1: null, address_line2: null, city: null, region: null,
  postal_code: null, country: 'US', notes: null,
  account_manager: null, contact_count: 0, logo_url: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/stakeholders/clients/c1']}>
      <Routes>
        <Route path="/stakeholders/clients/:id" element={<StakeholderDetail kind="client" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const moveInitiative = (over: Partial<InitiativeItem> = {}): InitiativeItem => ({
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
});

const contact = (over: Partial<ContactItem> = {}): ContactItem => ({
  person_id: 'p1', display_name: 'Grace Hopper', email: 'grace@acme.example',
  phone: null, job_title: 'Ops Lead', avatar_url: null, has_account: false,
  granted_at: '2026-01-01T00:00:00Z', tier: 'admin', org_title: null, functions: [],
  ...over,
});

const worker = (over: Partial<WorkerItem> = {}): WorkerItem => ({
  person_id: 'w1', display_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace',
  contact_email: null, phone: null, avatar_url: null, has_account: false,
  trade: 'Electrician', level: 'Journeyman', status: 'active', status_label: 'Active',
  status_color: '#178a4c', status_note: null, partner: null, cert_count: 0, certs_expired: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.global = true;
});

it('renders a safe http(s) website as a link', async () => {
  api.getOrg.mockResolvedValue(org({ website: 'https://acme.example' }));
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);

  renderPage();

  const links = await screen.findAllByRole('link', { name: 'https://acme.example' });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute('href')).toBe('https://acme.example');
  }
});

it('renders a javascript: website as plain text, never as a link', async () => {
  const bad = 'javascript:alert(1)';
  api.getOrg.mockResolvedValue(org({ website: bad }));
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);

  renderPage();

  await waitFor(() => expect(screen.queryAllByText(bad).length).toBeGreaterThan(0));
  expect(screen.queryByRole('link', { name: bad })).toBeNull();
  // and make sure no anchor on the page ever carries the bad value as href
  const anchors = document.querySelectorAll('a[href]');
  for (const a of anchors) {
    expect(a.getAttribute('href')).not.toBe(bad);
  }
});

it('previous initiatives: column floors, shared template + minimum, sideways-scroll card', async () => {
  api.getOrg.mockResolvedValue(org());
  api.listInitiatives.mockResolvedValue([moveInitiative()]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);

  renderPage();

  const row = (await screen.findByText('Denver DC migration')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // LIST_FIT.initPanel: .init-panel (initiatives.css: 16px 18px padding,
  // 1px border) takes 38px off the measured 1174px page width.
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

it('people (contacts): column floors, shared template + minimum, sideways-scroll card', async () => {
  api.getOrg.mockResolvedValue(org());
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([contact()]);
  api.listPartnerTypes.mockResolvedValue([]);

  renderPage();

  const row = (await screen.findByText('Grace Hopper')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

it('workers (partner only): column floors, shared template + minimum, sideways-scroll card', async () => {
  api.getOrg.mockResolvedValue(partnerOrg());
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);
  api.listPartnerWorkers.mockResolvedValue([worker()]);
  api.listPartnerChildren.mockResolvedValue([]);

  renderPartnerPage();

  const row = (await screen.findByText('Ada Lovelace')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

/* ── Parent partner row + Child partners panel ──────────────────────── */

const child = (over: Partial<OrgItem>): OrgItem => partnerOrg({
  partner_types: ['logistics'], service_region: 'Southeast US', parent_id: 'pt1',
  parent_name: 'Acme Logistics', ...over,
});

function mockPartnerPage(org: OrgItem, children: OrgItem[]) {
  api.getOrg.mockResolvedValue(org);
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);
  api.listPartnerWorkers.mockResolvedValue([]);
  api.listPartnerChildren.mockResolvedValue(children);
}

const childPanel = () =>
  screen.getByText('Child partners').closest('.init-panel') as HTMLElement;

it('Details shows a Parent partner row linking to the parent, only when set', async () => {
  mockPartnerPage(partnerOrg({ parent_id: 'pp1', parent_name: 'Zeta Holdings' }), []);
  renderPartnerPage();
  const link = await screen.findByRole('link', { name: 'Zeta Holdings' });
  expect(link.getAttribute('href')).toBe('/stakeholders/partners/pp1');
  expect(screen.getByText('Parent partner').tagName).toBe('DT');

  cleanup();
  mockPartnerPage(partnerOrg({ parent_id: null, parent_name: null }), []);
  renderPartnerPage();
  await screen.findByText('Acme Logistics');
  expect(screen.queryByText('Parent partner')).toBeNull();
});

it('a parent the viewer cannot see (parent_id null) shows no Parent partner row', async () => {
  mockPartnerPage(partnerOrg({ parent_id: null, parent_name: null }), []);
  renderPartnerPage();
  await screen.findByText('Acme Logistics');
  expect(screen.queryByText('Parent partner')).toBeNull();
});

it('Child partners lists the children (name link, types, region, status) with a count', async () => {
  mockPartnerPage(partnerOrg({ child_count: 2 }), [
    child({ id: 'c10', name: 'Branch 10' }), child({ id: 'c2', name: 'Branch 2', status: 'inactive' }),
  ]);
  renderPartnerPage();
  const link = await screen.findByRole('link', { name: 'Branch 2' });
  expect(link.getAttribute('href')).toBe('/stakeholders/partners/c2');
  const panel = childPanel();
  expect(within(panel).getAllByText('Southeast US', { selector: '.cell-line' })).toHaveLength(2);
  expect(panel.querySelector('.badge-count')!.textContent).toBe('2');
  // natural order: Branch 2 before Branch 10
  const names = [...panel.querySelectorAll('.dir-row .cell:first-child')].map((c) => c.textContent);
  expect(names).toEqual(['Branch 2', 'Branch 10']);
  expect(api.listPartnerChildren).toHaveBeenCalledWith('pt1');
});

it('Child partners: column floors, shared template + minimum, sideways-scroll card', async () => {
  mockPartnerPage(partnerOrg(), [child({ id: 'c1', name: 'Branch One' })]);
  renderPartnerPage();
  const row = (await screen.findByText('Branch One')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

it('staff with no children see the panel with its empty state and an Add child button', async () => {
  mockPartnerPage(partnerOrg(), []);
  renderPartnerPage();
  expect(await screen.findByText('No child partners.')).not.toBeNull();
  expect(within(childPanel()).getByRole('button', { name: 'Add child' })).not.toBeNull();
});

it('a partner-scoped user with no children does not see the panel at all', async () => {
  auth.global = false;
  mockPartnerPage(partnerOrg(), []);
  renderPartnerPage();
  await screen.findByText('Acme Logistics');
  await waitFor(() => expect(api.listPartnerChildren).toHaveBeenCalled());
  expect(screen.queryByText('Child partners')).toBeNull();
});

it('a partner-scoped user sees the children but no Add child or Remove', async () => {
  auth.global = false;
  mockPartnerPage(partnerOrg(), [child({ id: 'c1', name: 'Branch One' })]);
  renderPartnerPage();
  await screen.findByText('Branch One');
  expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
  expect(within(childPanel()).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('the panel and Add child are partners-only: a client page has neither', async () => {
  api.getOrg.mockResolvedValue(org());
  api.listInitiatives.mockResolvedValue([]);
  api.listOrgContacts.mockResolvedValue([]);
  api.listPartnerTypes.mockResolvedValue([]);
  renderPage();
  await screen.findByText('Acme');
  expect(screen.queryByText('Child partners')).toBeNull();
  expect(api.listPartnerChildren).not.toHaveBeenCalled();
});

it('Remove asks for confirmation, then clears the child parent and refreshes the list', async () => {
  mockPartnerPage(partnerOrg(), [child({ id: 'c1', name: 'Branch One' })]);
  api.setPartnerParent.mockResolvedValue(child({ id: 'c1', parent_id: null }));
  const confirm = vi.spyOn(window, 'confirm');
  renderPartnerPage();
  await screen.findByText('Branch One');

  confirm.mockReturnValueOnce(false);
  fireEvent.click(within(childPanel()).getByRole('button', { name: /Actions/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  expect(api.setPartnerParent).not.toHaveBeenCalled();

  confirm.mockReturnValueOnce(true);
  api.listPartnerChildren.mockResolvedValue([]);
  fireEvent.click(within(childPanel()).getByRole('button', { name: /Actions/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  await waitFor(() => expect(api.setPartnerParent).toHaveBeenCalledWith('c1', null));
  expect(await screen.findByText('No child partners.')).not.toBeNull();
  confirm.mockRestore();
});

it('Add child opens the house-header modal; its picker offers only parentless partners, not this one or its ancestors', async () => {
  // Grand > Acme (this page); Free and Held are others; Held already has a parent
  const grand = partnerOrg({ id: 'gp', name: 'Grand Parent Co' });
  const acme = partnerOrg({ parent_id: 'gp', parent_name: 'Grand Parent Co' });
  const free = partnerOrg({ id: 'fr', name: 'Free Agent Co' });
  const held = partnerOrg({ id: 'he', name: 'Held Co', parent_id: 'gp', parent_name: 'Grand Parent Co' });
  mockPartnerPage(acme, []);
  api.listPartnerItems.mockResolvedValue([grand, acme, free, held]);
  renderPartnerPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add child' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Partners').className).toContain('eyebrow');
  expect(within(dialog).getByRole('heading', { name: 'Add a child partner' })).not.toBeNull();
  expect(dialog.querySelector('.page-hint')).not.toBeNull();
  expect(dialog.className).toContain('rgm-card');

  fireEvent.focus(within(dialog).getByRole('combobox'));
  const labels = [...document.querySelectorAll('.combo-menu .kbar-item')]
    .map((b) => (b.firstChild?.textContent ?? '').trim());
  expect(labels).toEqual(['Free Agent Co']);
});

it('Add child: picking a partner sets its parent to this partner, closes, and refreshes', async () => {
  const free = partnerOrg({ id: 'fr', name: 'Free Agent Co' });
  mockPartnerPage(partnerOrg(), []);
  api.listPartnerItems.mockResolvedValue([partnerOrg(), free]);
  api.setPartnerParent.mockResolvedValue(child({ id: 'fr', name: 'Free Agent Co' }));
  renderPartnerPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add child' }));
  const dialog = await screen.findByRole('dialog');
  const submit = within(dialog).getByRole('button', { name: 'Add as child' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);   // nothing picked yet

  fireEvent.focus(within(dialog).getByRole('combobox'));
  fireEvent.mouseDown(screen.getByRole('button', { name: 'Free Agent Co' }));
  api.listPartnerChildren.mockResolvedValue([child({ id: 'fr', name: 'Free Agent Co' })]);
  fireEvent.click(submit);

  await waitFor(() => expect(api.setPartnerParent).toHaveBeenCalledWith('fr', 'pt1'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await screen.findByRole('link', { name: 'Free Agent Co' })).not.toBeNull();
});

it('Add child: an API refusal shows its message in the modal and keeps it open', async () => {
  const { ApiError } = await import('../lib/api');
  mockPartnerPage(partnerOrg(), []);
  api.listPartnerItems.mockResolvedValue([partnerOrg(), partnerOrg({ id: 'fr', name: 'Free Agent Co' })]);
  api.setPartnerParent.mockRejectedValue(new ApiError(422, 'circular_parent'));
  renderPartnerPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add child' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.focus(within(dialog).getByRole('combobox'));
  fireEvent.mouseDown(screen.getByRole('button', { name: 'Free Agent Co' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add as child' }));
  expect(await within(dialog).findByText('That would make a partner its own ancestor.')).not.toBeNull();
  expect(screen.queryByRole('dialog')).not.toBeNull();
});
