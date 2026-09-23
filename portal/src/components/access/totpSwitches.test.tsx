// @vitest-environment jsdom
/** Require 2FA switches on the group and role cards call the PATCH endpoints. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  patchAccessGroup: vi.fn(async () => {}),
  patchRole: vi.fn(async () => {}),
  listUsers: vi.fn(async () => []),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: GroupsTab } = await import('./GroupsTab');
const { default: RolesTab } = await import('./RolesTab');

const SUMMARY = {
  stats: { members: 0, roles: 1, groups: 1, gated_resources: 0, overrides: 0 },
  resources: [],
  roles: [{ name: 'staff', label: 'Staff', color: null, description: '', rank: 40, scope_anchor: 'global',
            is_system: true, member_count: 0, matrix: {}, totp_required: false }],
  groups: [{ id: 'g1', name: 'Finance', description: '', icon: 'users', member_count: 0, members: [], totp_required: false }],
} as never;

afterEach(cleanup);

it('group card switch PATCHes the group', async () => {
  render(<GroupsTab summary={SUMMARY} canEdit onChanged={() => {}} initialGroupId="g1" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /require 2fa/i }));
  await waitFor(() => expect(api.patchAccessGroup).toHaveBeenCalledWith('g1', { totp_required: true }));
});

it('role card switch PATCHes the role', async () => {
  render(<RolesTab summary={SUMMARY} canEdit maxRank={100} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /require 2fa/i }));
  await waitFor(() => expect(api.patchRole).toHaveBeenCalledWith('staff', { totp_required: true }));
});
