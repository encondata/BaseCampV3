// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const { exportCsv } = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('@portal/lib/listTools', () => ({ exportCsv }));

import type { ImportRun } from '../lib/sirdarApi';
import ImportSummaryModal from './ImportSummaryModal';

afterEach(cleanup);

const run: ImportRun = {
  id: 'r1', started_at: '2026-10-01T12:00:00Z', finished_at: '2026-10-01T12:00:01Z',
  trigger: 'web', status: 'ok', error: null, actor_name: 'Boss User',
  added: 1, updated: 1, unchanged: 0, disabled: 1, skipped: 1,
  rows: [
    { person_id: '1', email: 'a@x.co', name: 'Ann A', action: 'added', reason: null, roles: ['admin'], changes: [] },
    { person_id: '2', email: 'b@x.co', name: 'Bo B', action: 'updated', reason: null, roles: ['admin'], changes: ['first_name'] },
    { person_id: '3', email: 'c@x.co', name: 'Cy C', action: 'disabled', reason: 'not_eligible', roles: [], changes: [] },
    { person_id: null, email: 'd@x.co', name: 'Di D', action: 'skipped', reason: 'email_collision_local', roles: ['admin'], changes: [] },
  ],
};

it('shows counts, one row per person and a CSV download', async () => {
  render(<ImportSummaryModal run={run} onClose={() => {}} />);
  expect(screen.getByText('Import finished')).toBeTruthy();
  expect(screen.getByText('Ann A')).toBeTruthy();
  expect(screen.getByText(/no longer has an admin-or-higher role/i)).toBeTruthy();
  expect(screen.getByText(/local user already has this email/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /download csv/i }));
  expect(exportCsv).toHaveBeenCalledWith('sirdar-import-r1.csv', expect.any(Array), run.rows);
});
