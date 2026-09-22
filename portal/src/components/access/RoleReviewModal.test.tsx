// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewRoleMatrix: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: RoleReviewModal } = await import('./RoleReviewModal');

afterEach(cleanup);

const role = { name: 'staff', label: 'Staff', color: null, description: '', rank: 40,
  scope_anchor: 'global', is_system: true, member_count: 2, matrix: {} } as never;
const resources = [
  { id: 'workers', label: 'Workers', developer_only: false, always_viewable: false, gated_by: [] },
  { id: 'settings', label: 'Settings', developer_only: false, always_viewable: false, gated_by: [] },
];

it('summarizes grants and members, expands flips and masks, confirms', async () => {
  api.previewRoleMatrix.mockResolvedValue({
    role: 'staff', granted: ['settings:change'], revoked: ['workers:delete'],
    member_count: 2, affected_count: 1,
    members: [
      { person_id: 'p1', display_name: 'Plain Staff', avatar_url: null, max_rank: 40,
        flips: [{ resource: 'workers', action: 'delete', from: true, to: false }], masked: [] },
      { person_id: 'p2', display_name: 'Over Staff', avatar_url: null, max_rank: 40,
        flips: [], masked: [{ resource: 'workers', action: 'delete', by: 'override' }] },
    ],
  });
  const onConfirm = vi.fn(async () => {});
  render(<RoleReviewModal role={role} matrix={{}} resources={resources}
                          onBack={() => {}} onConfirm={onConfirm} />);
  expect(await screen.findByText('1 of 2 members affected')).toBeTruthy();
  expect(screen.getByText('Settings · change')).toBeTruthy();
  expect(screen.getByText('Workers · delete')).toBeTruthy();
  fireEvent.click(screen.getByText('Plain Staff'));
  expect(screen.getByText('Workers · delete: on → off')).toBeTruthy();
  fireEvent.click(screen.getByText('Over Staff'));
  expect(screen.getByText('Workers · delete — unchanged, decided by override')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
});

it('says when nobody holds the role and still allows confirm', async () => {
  api.previewRoleMatrix.mockResolvedValue({ role: 'staff', granted: [], revoked: ['workers:delete'],
    member_count: 0, affected_count: 0, members: [] });
  render(<RoleReviewModal role={role} matrix={{}} resources={resources}
                          onBack={() => {}} onConfirm={async () => {}} />);
  expect(await screen.findByText('No one holds this role')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
});
