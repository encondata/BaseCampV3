// @vitest-environment jsdom
/** The user page's Require 2FA switch says when two-factor is off site-wide,
 *  and its notification-groups table lists only channels that can send. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { UserDetailOut, UserNotificationGroup } from '../../lib/api';

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  listUserTrustedBrowsers: vi.fn(async () => ({ trust_days: 7, browsers: [] })),
}));

const { default: UserProfileTab } = await import('./UserProfileTab');

const DETAIL: UserDetailOut = {
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
    totp_enrolled: false, totp_enrolled_at: null, totp_required: false, totp_effective_required: false,
    two_factor_enabled: false },
  roles: [], max_rank: 40, worker: null, notification_groups: [], access: null, sessions: null,
};

const NOTE = /Not in effect — two-factor is off in/;

function renderTab(
  twoFactorEnabled: boolean, canManageUsers = true, groups: UserNotificationGroup[] = [],
) {
  const detail = {
    ...DETAIL, notification_groups: groups,
    account: { ...DETAIL.account, two_factor_enabled: twoFactorEnabled },
  };
  return render(
    <MemoryRouter>
      <UserProfileTab detail={detail} mode="manage" canManageUsers={canManageUsers} reloadKey={0}
                      onEdit={() => {}} onReset={() => {}} onSignOutAll={() => {}}
                      onResetTotp={() => {}} onToggleTotpRequired={async () => {}} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

it('with two-factor off, the Require 2FA switch says it is not in effect and links to Security', () => {
  renderTab(false);
  expect(screen.getByRole('checkbox', { name: /require 2fa/i })).toBeTruthy();
  expect(screen.getByText(NOTE).textContent)
    .toBe('Not in effect — two-factor is off in System settings › Security.');
  expect(screen.getByRole('link', { name: 'System settings › Security' }).getAttribute('href'))
    .toBe('/settings/security');
});

it('with two-factor on, no note', () => {
  renderTab(true);
  expect(screen.getByRole('checkbox', { name: /require 2fa/i })).toBeTruthy();
  expect(screen.queryByText(NOTE)).toBeNull();
});

it('no switch, no note', () => {
  renderTab(false, false);
  expect(screen.queryByRole('checkbox', { name: /require 2fa/i })).toBeNull();
  expect(screen.queryByText(NOTE)).toBeNull();
});

const membership = (id: string, name: string, channels: string[]): UserNotificationGroup => (
  { id, name, channels, added_at: '2026-02-01T00:00:00Z' }
);

it('notification groups list only the channels that can send, or No email', () => {
  renderTab(true, true, [
    membership('g1', 'Night Desk', ['text', 'push', 'web']),
    membership('g2', 'Ops Alerts', ['email', 'web']),
    membership('g3', 'Muted Crew', []),
  ]);
  const table = within(screen.getByRole('table', { name: 'Notification groups' }));
  /** The chips in a membership's Channels cell (the second column). */
  const chipsOf = (group: string) => [
    ...(table.getByRole('link', { name: group }).closest('tr')!.querySelectorAll('td')[1]
      .querySelectorAll('.chip')),
  ] as HTMLElement[];

  // Stored text/push/web are hidden: nothing there can send.
  const [nightDesk, ...nightRest] = chipsOf('Night Desk');
  expect(nightDesk.textContent).toBe('No email');
  expect(nightDesk.className).toContain('c-slate');
  expect(nightRest).toEqual([]);

  // Email is listed, the hidden web channel next to it is not.
  const [opsAlerts, ...opsRest] = chipsOf('Ops Alerts');
  expect(opsAlerts.textContent).toBe('Email');
  expect(opsAlerts.className).toContain('c-blue');
  expect(opsRest).toEqual([]);

  // An empty channel list reads the same as one with nothing live; the old "muted" chip is gone.
  expect(chipsOf('Muted Crew').map((c) => c.textContent)).toEqual(['No email']);
  for (const raw of ['text', 'push', 'web', 'email', 'muted']) {
    expect(table.queryByText(raw)).toBeNull();
  }
});
