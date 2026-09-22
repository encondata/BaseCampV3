// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewRoleMatrix: vi.fn(), putRoleMatrix: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../lib/api');
type AccessSummary = import('../../lib/api').AccessSummary;
const { default: RolesTab } = await import('./RolesTab');

const summary = {
  stats: { members: 1, roles: 1, groups: 0, gated_resources: 0, overrides: 0 },
  resources: [
    { id: 'workers', label: 'Workers', developer_only: false, always_viewable: false, gated_by: [] },
  ],
  roles: [
    { name: 'staff', label: 'Staff', color: null, description: 'Field staff', rank: 40,
      scope_anchor: 'global', is_system: true, member_count: 1,
      matrix: { workers: { view: true, add: false, change: false, delete: false } } },
  ],
  groups: [],
} as never;

const emptyPreview = {
  role: 'staff', granted: ['workers:add'], revoked: [],
  member_count: 0, affected_count: 0, members: [],
};

/** The first unlocked matrix checkbox — Workers · add. */
const addCell = () =>
  document.querySelectorAll<HTMLButtonElement>('.pm-table tbody tr button.pm-chk')[1];

beforeEach(() => {
  api.previewRoleMatrix.mockReset().mockResolvedValue(emptyPreview);
  api.putRoleMatrix.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it('reviews before it saves, then saves the draft and refetches', async () => {
  const onChanged = vi.fn(async () => {});
  render(<RolesTab summary={summary} canEdit maxRank={100} onChanged={onChanged} />);

  fireEvent.click(addCell());
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByText('No one holds this role')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Review role changes' })).toBeTruthy();
  expect(api.putRoleMatrix).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(api.putRoleMatrix).toHaveBeenCalledWith('staff', {
    workers: { view: true, add: true, change: false, delete: false },
  }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it('keeps the review open and explains a rejected save', async () => {
  api.putRoleMatrix.mockRejectedValue(new ApiError(403, 'rank_too_low'));
  const onChanged = vi.fn(async () => {});
  render(<RolesTab summary={summary} canEdit maxRank={100} onChanged={onChanged} />);

  fireEvent.click(addCell());
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('No one holds this role')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  await waitFor(() => expect(
    screen.getAllByText('Your rank is too low to change this role.').length).toBeGreaterThan(0));
  expect(screen.getByRole('dialog', { name: 'Review role changes' })).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
});

it('closes the review before the refetch, so it never previews the saved matrix', async () => {
  // The refetch replaces the role object; a still-mounted review would
  // re-run its effect against the new draft and preview a no-op change.
  function Host() {
    const [current, setCurrent] = useState(summary);
    return (
      <RolesTab summary={current} canEdit maxRank={100} onChanged={async () => {
        setCurrent({
          ...(current as AccessSummary),
          roles: [{ ...(current as AccessSummary).roles[0],
                    matrix: { workers: { view: true, add: true, change: false, delete: false } } }],
        } as never);
      }} />
    );
  }
  render(<Host />);
  fireEvent.click(addCell());
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('No one holds this role')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.previewRoleMatrix).toHaveBeenCalledTimes(1);
});
