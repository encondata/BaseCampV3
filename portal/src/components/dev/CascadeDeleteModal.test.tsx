// @vitest-environment jsdom
/**
 * The override modal: it must show what will die before it will let you
 * kill it, and the destroy button stays inert until the record's own name
 * is typed back.
 *
 * Note: this project does not register @testing-library/jest-dom matchers
 * (no setupFiles/expect.extend — see vitest.config.ts), so disabled-state
 * assertions read the DOM `disabled` property directly rather than using
 * `toBeDisabled()`, matching the pattern used across the rest of the
 * portal's tests (e.g. NotificationsPanel.test.tsx, SecurityControls.test.tsx).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CascadePlan } from '../../lib/api';

const api = vi.hoisted(() => ({
  getCascadePreview: vi.fn(),
  cascadeDelete: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const PLAN: CascadePlan = {
  entity_type: 'person',
  entity_id: 'p1',
  label: 'Guido Huizing',
  steps: [
    { table: 'user_accounts', column: 'person_id', action: 'purge', count: 1, labels: ['guido@x.test'], depth: 0 },
    { table: 'auth_sessions', column: 'person_id', action: 'purge', count: 2, labels: [], depth: 1 },
    { table: 'audit_log', column: 'actor_person_id', action: 'clear', count: 5, labels: [], depth: 0 },
    { table: 'notification_group_members', column: 'person_id', action: 'db_cascade', count: 1, labels: ['Ops'], depth: 0 },
  ],
  blocked: [],
  total_rows_deleted: 3,
  total_rows_cleared: 5,
  total_rows_db_deleted: 1,
};

const onClose = vi.fn();
const onDeleted = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getCascadePreview.mockResolvedValue(PLAN);
  api.cascadeDelete.mockResolvedValue({ deleted: 1, failed: [] });
});
afterEach(cleanup);

const { default: CascadeDeleteModal } = await import('./CascadeDeleteModal');

const renderModal = () => render(
  <CascadeDeleteModal markerId="m1" label="Guido Huizing"
                      onClose={onClose} onDeleted={onDeleted} />,
);

it('renders every step with its wording and counts', async () => {
  renderModal();
  expect(await screen.findByRole('table', { name: 'Cascade delete plan' })).toBeTruthy();
  expect(screen.getByText('user_accounts')).toBeTruthy();
  expect(screen.getAllByText('Deleted').length).toBe(2);
  expect(screen.getByText('Reference cleared')).toBeTruthy();
  expect(screen.getByText('Deleted by the database')).toBeTruthy();
  // 3 purged (1 + 2) + 1 the database deletes via ON DELETE CASCADE = 4,
  // across 3 tables (user_accounts, auth_sessions, notification_group_members)
  expect(screen.getByText(/4 rows in 3 tables will be permanently deleted/)).toBeTruthy();
});

it('keeps the destroy button disabled until the label is typed exactly', async () => {
  renderModal();
  const button = await screen.findByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const field = screen.getByLabelText(/Type Guido Huizing to confirm/);
  fireEvent.change(field, { target: { value: 'guido huizing' } });
  expect(button.disabled).toBe(true);
  fireEvent.change(field, { target: { value: '  Guido Huizing  ' } });
  expect(button.disabled).toBe(false);
});

it('posts the typed label and reports the result', async () => {
  renderModal();
  const button = await screen.findByRole('button', { name: 'Delete permanently' });
  fireEvent.change(screen.getByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  fireEvent.click(button);
  await waitFor(() => expect(api.cascadeDelete).toHaveBeenCalledWith('m1', 'Guido Huizing'));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ deleted: 1, failed: [] }));
});

it('never enables the button for a blocked plan', async () => {
  api.getCascadePreview.mockResolvedValue({
    ...PLAN, blocked: ['processed_scans.person_id is kept non-null by a database rule'] });
  renderModal();
  expect(await screen.findByText(/kept non-null by a database rule/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps itself open and explains a server refusal', async () => {
  const { ApiError } = await import('../../lib/api');
  api.cascadeDelete.mockRejectedValue(new ApiError(422, 'label_mismatch'));
  renderModal();
  fireEvent.change(await screen.findByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(await screen.findByText(/name did not match/i)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

it('offers a retry when the preview cannot be built', async () => {
  api.getCascadePreview.mockRejectedValueOnce(new Error('network'));
  renderModal();
  expect(await screen.findByText('Could not build the delete plan.')).toBeTruthy();
  api.getCascadePreview.mockResolvedValue(PLAN);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table', { name: 'Cascade delete plan' })).toBeTruthy();
});

it('surfaces the server reasons when a delete is refused as cascade_blocked', async () => {
  const { ApiError } = await import('../../lib/api');
  api.cascadeDelete.mockRejectedValue(new ApiError(
    409, 'cascade_blocked',
    { code: 'cascade_blocked', reasons: ['newly_added.column is kept non-null by a database rule'] }));
  renderModal();
  fireEvent.change(await screen.findByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(await screen.findByText('newly_added.column is kept non-null by a database rule')).toBeTruthy();
  // the preview is re-fetched rather than left stale
  await waitFor(() => expect(api.getCascadePreview).toHaveBeenCalledTimes(2));
});
