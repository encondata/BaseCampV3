// @vitest-environment jsdom
/** Require 2FA switches on the group and role cards call the PATCH endpoints,
 *  and say when the site's two-factor switch is off. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

it('role card switch locks in-flight so a double click only fires one PATCH', async () => {
  let resolvePatch: () => void = () => {};
  api.patchRole.mockImplementationOnce(() => new Promise<void>((res) => { resolvePatch = res; }));
  render(<RolesTab summary={SUMMARY} canEdit maxRank={100} onChanged={() => {}} />);
  const sw = await screen.findByRole('checkbox', { name: /require 2fa/i }) as HTMLInputElement;
  const callsBefore = api.patchRole.mock.calls.length;
  fireEvent.click(sw);
  await waitFor(() => expect(sw.disabled).toBe(true));
  // The switch is disabled by now, but jsdom's synthetic `click` still fires
  // a `change` on a disabled checkbox, so the real guard under test is
  // `setTotp`'s own `saving` check, not the DOM's disabled state.
  fireEvent.click(sw);
  expect(api.patchRole.mock.calls.length - callsBefore).toBe(1);
  resolvePatch();
  await waitFor(() => expect(sw.disabled).toBe(false));
});

const NOTE = /Not in effect — two-factor is off in/;
const withTwoFactor = (on: boolean) => ({ ...(SUMMARY as object), two_factor_enabled: on }) as never;

it('with two-factor off, the role and group switches stay usable and show the note', async () => {
  render(<MemoryRouter>
    <RolesTab summary={withTwoFactor(false)} canEdit maxRank={100} onChanged={() => {}} />
    <GroupsTab summary={withTwoFactor(false)} canEdit onChanged={() => {}} initialGroupId="g1" />
  </MemoryRouter>);
  const switches = await screen.findAllByRole('checkbox', { name: /require 2fa/i });
  expect(switches).toHaveLength(2);
  for (const sw of switches) expect((sw as HTMLInputElement).disabled).toBe(false);
  expect(screen.getAllByText(NOTE)).toHaveLength(2);
  for (const link of screen.getAllByRole('link', { name: 'System settings › Security' })) {
    expect(link.getAttribute('href')).toBe('/settings/security');
  }
});

it('with two-factor on, no note on either card', async () => {
  render(<MemoryRouter>
    <RolesTab summary={withTwoFactor(true)} canEdit maxRank={100} onChanged={() => {}} />
    <GroupsTab summary={withTwoFactor(true)} canEdit onChanged={() => {}} initialGroupId="g1" />
  </MemoryRouter>);
  expect(await screen.findAllByRole('checkbox', { name: /require 2fa/i })).toHaveLength(2);
  expect(screen.queryByText(NOTE)).toBeNull();
});
