// @vitest-environment jsdom
/** Org affiliations show a client grant's group chips read-only, to staff. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { UserDetailOut } from '../../lib/api';

const auth = vi.hoisted(() => ({ global: true }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ scope: { global: auth.global, client_ids: [], partner_ids: [] } }),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  listUserTrustedBrowsers: vi.fn(async () => ({ trust_days: 7, browsers: [] })),
  listClientGroups: vi.fn(async () => [{ id: 'g1', name: 'Dallas', aliases: [], asset_count: 0, people_count: 0 }]),
}));

const { default: UserProfileTab } = await import('./UserProfileTab');

const DETAIL = {
  person: {
    id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null,
    display_name: 'Wan Worker', email: 'wan@x.test', phone: null, job_title: null,
    address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
    country: 'US', badge_uid: 'B1', created_at: '2026-01-01T00:00:00Z', avatar_key: null,
    avatar_url: null, password_updated_at: null, source: 'manual', source_ref: null,
    archived_at: null,
  },
  account: { login_email: 'wan@x.test', status: 'active', must_change_password: false,
    last_login_at: null, created_at: '2026-01-01T00:00:00Z', password_updated_at: null,
    totp_enrolled: false, totp_enrolled_at: null, totp_required: false,
    totp_effective_required: false, two_factor_enabled: false },
  roles: [{ role: 'client_viewer', label: 'Client viewer', rank: 10, scope_anchor: 'client',
    org: { kind: 'client', id: 'c1', name: 'Acme' }, granted_by: null,
    granted_at: '2026-01-01T00:00:00Z', group_ids: ['g1'] }],
  max_rank: 10, worker: null, notification_groups: [], access: null, sessions: null,
} as unknown as UserDetailOut;

const renderTab = () => render(
  <MemoryRouter>
    <UserProfileTab detail={DETAIL} mode="manage" canManageUsers reloadKey={0}
                    onEdit={() => {}} onReset={() => {}} onSignOutAll={() => {}}
                    onResetTotp={() => {}} onToggleTotpRequired={async () => {}} />
  </MemoryRouter>,
);

afterEach(cleanup);

it('shows the grant\'s group chips to staff', async () => {
  auth.global = true;
  renderTab();
  expect(await screen.findByText('Dallas')).not.toBeNull();
});

it('shows no group names to a non-global viewer', async () => {
  auth.global = false;
  renderTab();
  expect(screen.getByText('Client viewer')).not.toBeNull();
  expect(screen.queryByText('Dallas')).toBeNull();
});
