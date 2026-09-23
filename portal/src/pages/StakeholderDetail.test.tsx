// @vitest-environment jsdom
/**
 * /stakeholders/clients/:id and /partners/:id — the Full Details page.
 * Narrow regression coverage for security-fixes task 7: a bad (non-http)
 * `website` value must render as plain text, never as a clickable anchor
 * — the API normalizes/validates on write, but this is the independent
 * render-time guard (lib/safeHref) in case a stored value predates that
 * or reached storage some other way.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ContactItem, InitiativeItem, UiPreferences } from '../lib/api';
import type { OrgItem } from '../lib/orgs';
import type { WorkerItem } from '../lib/workers';
import { LIST_FIT } from '../lib/listTools';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
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
  getOrg: vi.fn(),
  listInitiatives: vi.fn(),
  listOrgContacts: vi.fn(),
  listPartnerTypes: vi.fn(),
  listPartnerWorkers: vi.fn(),
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
