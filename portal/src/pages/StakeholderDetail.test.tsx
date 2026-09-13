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

import type { UiPreferences } from '../lib/api';
import type { OrgItem } from '../lib/orgs';

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
