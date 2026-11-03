// @vitest-environment jsdom
/**
 * /sites/:siteId — the Full Details page. This file covers the header's actions:
 * Watch is for everyone who can open the page, Edit only for those who can change
 * sites. The panels below the header (notes, the survey lists, the map) have their
 * own tests, so they are stand-ins here.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SiteItem } from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_resource: string, _action?: string): boolean => true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const api = vi.hoisted(() => ({
  getSite: vi.fn(),
  listSiteTypes: vi.fn(),
  listSiteStatuses: vi.fn(),
  listClients: vi.fn(),
  listPartners: vi.fn(),
  getWatchState: vi.fn(),
  createMyWatch: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

vi.mock('../components/NotesFilesPanel', () => ({ default: () => null }));
vi.mock('../components/sites/SiteSurveyList', () => ({ default: () => null }));
vi.mock('../components/sites/RawSurveyList', () => ({ default: () => null }));
vi.mock('../components/sites/SitesMap', () => ({ default: () => null }));

const SITE: SiteItem = {
  id: 's1', name: 'Site A', code: 'SA1',
  site_type: 'dc', type_label: 'Data center', type_color: '#3b82f6',
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
  country: 'US', latitude: null, longitude: null, timezone: null, dc_provider: null,
  partner_id: null, partner_name: null, notes: null, archived_at: null,
  created_at: '2026-09-01T10:00:00Z', clients: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getSite.mockResolvedValue(SITE);
  api.listSiteTypes.mockResolvedValue([]);
  api.listSiteStatuses.mockResolvedValue([]);
  api.listClients.mockResolvedValue([]);
  api.listPartners.mockResolvedValue([]);
  api.getWatchState.mockResolvedValue({ watching: false, watch_id: null, kinds: [] });
});

afterEach(cleanup);

const { default: SiteDetail } = await import('./SiteDetail');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sites/s1']}>
      <Routes>
        <Route path="/sites/:siteId" element={<SiteDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const headerActions = async () =>
  (await screen.findByRole('heading', { name: 'Site A' }))
    .closest('.idet-header')!.querySelector('.idet-header-actions') as HTMLElement;

const actionNames = (actions: HTMLElement) => [...actions.children].map((el) => el.textContent);

it('header: Watch comes first, then Edit, for someone who can change sites', async () => {
  renderPage();
  const actions = await headerActions();
  await within(actions).findByRole('button', { name: 'Watch' });

  expect(actionNames(actions)).toEqual(['Watch', 'Edit']);
  expect(api.getWatchState).toHaveBeenCalledWith('site', 's1');
});

it('header: Watch still shows without change permission, and Edit does not', async () => {
  auth.can = (resource, action) => !(resource === 'sites' && action === 'change');
  renderPage();
  const actions = await headerActions();
  await within(actions).findByRole('button', { name: 'Watch' });

  expect(actionNames(actions)).toEqual(['Watch']);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('header: a click on Watch watches this site', async () => {
  const user = userEvent.setup();
  api.createMyWatch.mockResolvedValue({
    id: 'w1', thing: 'site', thing_id: 's1', thing_name: 'Site A',
    link: '/sites/s1', kinds: [], via: { type: 'you' }, created_at: '2026-11-02T12:00:00Z',
  });
  renderPage();
  const actions = await headerActions();

  await user.click(await within(actions).findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyWatch)
    .toHaveBeenCalledWith({ thing: 'site', id: 's1', kinds: [] }));
  expect(await within(actions).findByRole('button', { name: 'Watching' })).not.toBeNull();
});

it('a missing site has no header, so no Watch button and no state request', async () => {
  api.getSite.mockRejectedValue(new Error('404'));
  renderPage();

  expect(await screen.findByText('Site not found')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
  expect(api.getWatchState).not.toHaveBeenCalled();
});
