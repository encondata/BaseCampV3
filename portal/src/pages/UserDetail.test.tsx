// @vitest-environment jsdom
/**
 * /people/users/:personId — hero, tabs, Profile tab panels, action gating.
 * The Access and History tabs get their own `it` blocks in later tasks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UserDetailOut } from '../lib/api';

const auth = vi.hoisted(() => ({
  personId: 'me-1',
  maxRank: 100,
  perms: new Set<string>(['users:view', 'users:change', 'access:view', 'access:change', 'audit:view']),
  godMode: false,
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: auth.personId, display_name: 'Me' },
    roles: ['admin'],
    maxRank: auth.maxRank,
    godMode: auth.godMode,
    can: (res: string, action = 'view') => auth.perms.has(`${res}:${action}`),
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
    applyProfile: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getUserDetail: vi.fn(),
  getUserActivity: vi.fn(async () => []),
  getAccessSummary: vi.fn(async () => ({
    stats: { members: 0, roles: 0, groups: 0, gated_resources: 0, overrides: 0 },
    resources: [{ id: 'clients', label: 'Clients', developer_only: false, always_viewable: false, gated_by: ['g1'] }],
    roles: [], groups: [{ id: 'g1', name: 'Finance', description: 'Money people', icon: 'users', member_count: 1, members: [] },
                        { id: 'g2', name: 'Ops', description: '', icon: 'users', member_count: 0, members: [] }],
  })),
  setUserAccessGroups: vi.fn(async (_id: string, ids: string[]) => ids),
  revokeAllUserSessions: vi.fn(async () => {}),
  getOverrides: vi.fn(async () => ({ overrides: {} })),
  putOverrides: vi.fn(async () => {}),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

export const DETAIL: UserDetailOut = {
  person: {
    id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null,
    display_name: 'Wan Worker', email: 'wan@x.test', phone: '555-0100', job_title: 'Tech',
    address_line1: '1 Main St', address_line2: null, city: 'Dallas', region: 'TX',
    postal_code: '75001', country: 'US', badge_uid: 'BADGE-1',
    created_at: '2026-01-01T00:00:00Z', avatar_key: null, avatar_url: null,
    password_updated_at: null, source: 'v2_import', source_ref: 'v2:people:42', archived_at: null,
  },
  account: { login_email: 'wan@x.test', status: 'active', must_change_password: true,
    last_login_at: '2026-09-14T12:00:00Z', created_at: '2026-01-02T00:00:00Z',
    password_updated_at: '2026-08-01T00:00:00Z' },
  roles: [
    { role: 'staff', label: 'Staff', rank: 40, scope_anchor: 'global', org: null,
      granted_by: { id: 'me-1', display_name: 'Me' }, granted_at: '2026-01-02T00:00:00Z' },
    { role: 'client_admin', label: 'Client admin', rank: 20, scope_anchor: 'client',
      org: { kind: 'client', id: 'c1', name: 'Acme' }, granted_by: null, granted_at: '2026-02-01T00:00:00Z' },
  ],
  max_rank: 40,
  worker: { trade: 'Cabling', level: 'l2', level_title: 'Journeyman', level_color: '#123456',
    partner: { id: 'pa1', name: 'Wire Co' }, status: 'active', status_label: 'Active', status_color: '#178a4c' },
  notification_groups: [{ id: 'ng1', name: 'Ops alerts', channels: ['email', 'web'], added_at: '2026-03-01T00:00:00Z' }],
  access: {
    groups: [{ id: 'g1', name: 'Finance', description: 'Money people', gate_count: 1, gated_pages: ['Clients'],
      added_by: { id: 'me-1', display_name: 'Me' }, added_at: '2026-04-01T00:00:00Z' }],
    overrides: [{ resource: 'sites', resource_label: 'Sites', action: 'delete', allow: true,
      set_by: { id: 'me-1', display_name: 'Me' }, set_at: '2026-05-01T00:00:00Z' }],
    scope: { global: true, client_ids: [], partner_ids: [] },
    scope_orgs: [],
    cells: { clients: { view: { value: true, source: 'role' }, add: { value: false, source: 'role' },
      change: { value: false, source: 'role' }, delete: { value: false, source: 'role' } } },
  },
  sessions: [{ family_id: 'f1', started_at: '2026-09-14T12:00:00Z', last_active_at: '2026-09-14T13:00:00Z',
    expires_at: '2026-09-21T12:00:00Z', ip_address: '10.0.0.5', user_agent: 'Mozilla/5.0 (Macintosh) Chrome/128' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.personId = 'me-1';
  auth.maxRank = 100;
  auth.perms = new Set(['users:view', 'users:change', 'access:view', 'access:change', 'audit:view']);
  api.getUserDetail.mockResolvedValue(DETAIL);
});
afterEach(cleanup);

const { default: UserDetail } = await import('./UserDetail');

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/people/users/:personId" element={<UserDetail />} />
        <Route path="/people/users/:personId/access" element={<UserDetail />} />
        <Route path="/people/users/:personId/history" element={<UserDetail />} />
        <Route path="/me" element={<div>ME PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('renders the hero, three tabs, and the Profile panels', async () => {
  renderAt('/people/users/p1');
  expect(await screen.findByRole('heading', { level: 1, name: /Wan Worker/ })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Access' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
  expect(screen.getByText('BADGE-1')).toBeTruthy();
  expect(screen.getByText('Imported from V2')).toBeTruthy();
  expect(screen.getByText('v2:people:42')).toBeTruthy();
  expect(screen.getByText('change required')).toBeTruthy();
  // memberships
  expect(screen.getByText('Cabling')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open worker page' }).getAttribute('href')).toBe('/people/workers/p1');
  expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('/stakeholders/clients/c1');
  expect(screen.getByRole('link', { name: 'Ops alerts' }).getAttribute('href')).toBe('/system/notifications/ng1');
  // sessions
  expect(screen.getByText('10.0.0.5', { exact: false })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeTruthy();
});

it('hides the History tab without audit:view and the sessions panel when null', async () => {
  auth.perms.delete('audit:view');
  api.getUserDetail.mockResolvedValue({ ...DETAIL, sessions: null });
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
  expect(screen.queryByText('Active sessions')).toBeNull();
});

it('self shows only "Go to My profile"', async () => {
  auth.personId = 'p1';
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByRole('button', { name: 'Go to My profile' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
});

it('an outranked person is read-only', async () => {
  auth.maxRank = 40;                     // same rank as Wan -> cannot touch
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByText(/rank is at or above yours/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disable account' })).toBeNull();
});

it('Sign out everywhere confirms, posts, and reloads', async () => {
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out all sessions' }));
  await waitFor(() => expect(api.revokeAllUserSessions).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(api.getUserDetail).toHaveBeenCalledTimes(2));
});

it('shows the not-found state on 404', async () => {
  const { ApiError } = await import('../lib/api');
  api.getUserDetail.mockRejectedValue(new ApiError(404, 'user_not_found'));
  renderAt('/people/users/nope');
  expect(await screen.findByText('User not found')).toBeTruthy();
  expect(screen.getByRole('link', { name: '← Users' }).getAttribute('href')).toBe('/people/users');
});

it('ignores a stale response when personId changes mid-load', async () => {
  let resolveP1: (d: UserDetailOut) => void = () => {};
  const p1 = new Promise<UserDetailOut>((res) => { resolveP1 = res; });
  const p2 = { ...DETAIL, person: { ...DETAIL.person, id: 'p2', display_name: 'Second Person' } };
  api.getUserDetail.mockImplementation((id: string) => (id === 'p1' ? p1 : Promise.resolve(p2)));
  render(
    <MemoryRouter initialEntries={['/people/users/p1']}>
      <Routes>
        <Route path="/people/users/:personId" element={<><Link to="/people/users/p2">go p2</Link><UserDetail /></>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('go p2'));
  expect(await screen.findByRole('heading', { level: 1, name: /Second Person/ })).toBeTruthy();
  resolveP1(DETAIL);                                   // the stale p1 answer arrives late
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('heading', { level: 1, name: /Second Person/ })).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1, name: /Wan Worker/ })).toBeNull();
});

it('Access tab renders four panels with real tables', async () => {
  renderAt('/people/users/p1/access');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.getByRole('tab', { name: 'Access' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('table', { name: 'Roles' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Access groups' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Overrides' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Effective permissions' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Finance' }).getAttribute('href')).toBe('/access?tab=groups&group=g1');
  expect(screen.getByText('Money people')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage groups' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit overrides' })).toBeTruthy();
});

it('Access tab shows the rank note when the access block is null but keeps Manage roles', async () => {
  api.getUserDetail.mockResolvedValue({ ...DETAIL, access: null });
  renderAt('/people/users/p1/access');
  await screen.findByRole('table', { name: 'Roles' });
  expect(screen.getByText(/visible to admins at rank 60 and above/)).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Access groups' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Manage groups' })).toBeNull();
});

it('Manage groups toggles and saves the full id list', async () => {
  renderAt('/people/users/p1/access');
  fireEvent.click(await screen.findByRole('button', { name: 'Manage groups' }));
  const ops = await screen.findByRole('button', { name: /^Ops/ });
  fireEvent.click(ops);                                   // add Ops (Finance already on)
  fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
  await waitFor(() => expect(api.setUserAccessGroups).toHaveBeenCalledWith('p1', ['g1', 'g2']));
  await waitFor(() => expect(api.getUserDetail).toHaveBeenCalledTimes(2));
});

it('Manage groups surfaces rank_too_low', async () => {
  const { ApiError } = await import('../lib/api');
  api.setUserAccessGroups.mockRejectedValueOnce(new ApiError(403, 'rank_too_low'));
  renderAt('/people/users/p1/access');
  fireEvent.click(await screen.findByRole('button', { name: 'Manage groups' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Finance/ }));   // remove Finance
  fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
  expect(await screen.findByText(/rank is at or above yours/)).toBeTruthy();
});
