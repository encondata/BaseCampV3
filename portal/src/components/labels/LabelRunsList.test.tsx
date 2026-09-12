// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelRun } from '../../lib/api';
import LabelRunsList from './LabelRunsList';

afterEach(cleanup);

const run = (over: Partial<LabelRun>): LabelRun => ({
  id: 'r1', initiative_id: 'i1', initiative_name: 'NAP11', label_types: ['top', 'front'],
  regenerate_existing: false, status: 'completed', cancel_requested: false,
  current_label_type: null, current_item: null, total: 100, processed: 100,
  generated: 98, skipped: 1, errors: 1, error_summary: {}, error_details: [], error: null,
  requested_by: 'p1', requested_by_name: 'Alice', notify: false,
  created_at: '2026-09-11T00:00:00Z', started_at: '2026-09-11T00:00:01Z',
  finished_at: '2026-09-11T00:05:00Z', progress_pct: 100, ...over,
});
const typeLabel = (key: string) => (key === 'top' ? 'Top Label' : 'Front Label');

it('shows loading, empty, and populated states', () => {
  const { rerender } = render(<LabelRunsList runs={null} typeLabel={typeLabel} onViewErrors={() => {}} />);
  expect(screen.getByText('Loading…')).not.toBeNull();
  rerender(<LabelRunsList runs={[]} typeLabel={typeLabel} onViewErrors={() => {}} />);
  expect(screen.getByText('No runs yet.')).not.toBeNull();
  rerender(<LabelRunsList runs={[run({})]} typeLabel={typeLabel} onViewErrors={() => {}} />);
  expect(screen.getByText('NAP11')).not.toBeNull();
  expect(screen.getByText('Top Label')).not.toBeNull();
  expect(screen.getByText('Completed')).not.toBeNull();
  expect(screen.getByText('98 / 1 / 1')).not.toBeNull();
  expect(screen.getByText('Alice')).not.toBeNull();
});

it('highlights the deep-linked run', () => {
  render(<LabelRunsList runs={[run({ id: 'r2' })]} highlightRunId="r2" typeLabel={typeLabel}
                         onViewErrors={() => {}} />);
  expect(document.querySelector('.dir-row.row-highlight')).not.toBeNull();
});

it('"View errors" row action appears only when the run has errors, and calls onViewErrors', async () => {
  const user = userEvent.setup();
  const onViewErrors = vi.fn();
  render(<LabelRunsList runs={[run({ id: 'r-err', errors: 3 }), run({ id: 'r-clean', errors: 0 })]}
                         typeLabel={typeLabel} onViewErrors={onViewErrors} />);
  const triggers = screen.getAllByRole('button', { name: /actions|⋮|More/i });
  expect(triggers.length).toBe(1);
  await user.click(triggers[0]);
  await user.click(await screen.findByText('View errors'));
  expect(onViewErrors).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-err' }));
});
