// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelRun } from '../../lib/api';
import LabelRunErrorsModal from './LabelRunErrorsModal';

afterEach(cleanup);

const typeLabel = (key: string) => (key === 'top' ? 'Top Label' : key);

const run = (over: Partial<LabelRun>): LabelRun => ({
  id: 'r1', initiative_id: 'i1', initiative_name: 'NAP11', label_types: ['top'],
  regenerate_existing: false, status: 'completed', cancel_requested: false,
  current_label_type: null, current_item: null, total: 10, processed: 10,
  generated: 7, skipped: 0, errors: 3,
  error_summary: { no_template: 2, unknown_token: 1 },
  error_details: [
    { item: 'A-1001', label_type: 'top', type: 'no_template', message: 'No active template for top' },
    { item: 'A-1002', label_type: 'top', type: 'no_template', message: 'No active template for top' },
    { item: 'A-1003', label_type: 'top', type: 'unknown_token', message: 'Unknown token {row}' },
  ],
  error: null, requested_by: 'p1', requested_by_name: 'Alice', notify: false,
  created_at: '2026-09-11T00:00:00Z', started_at: '2026-09-11T00:00:01Z',
  finished_at: '2026-09-11T00:01:00Z', progress_pct: 100, ...over,
});

it('shows the roomy header (eyebrow, count+initiative title, description)', () => {
  render(<LabelRunErrorsModal run={run({})} typeLabel={typeLabel} onClose={() => {}} />);
  expect(screen.getByText('Generate Labels')).not.toBeNull();
  expect(screen.getByText('3 errors in NAP11')).not.toBeNull();
});

it('renders summary-by-type chips sorted by count, and sample rows', () => {
  render(<LabelRunErrorsModal run={run({})} typeLabel={typeLabel} onClose={() => {}} />);
  const chips = screen.getAllByText(/no_template|unknown_token/);
  expect(chips[0].textContent).toContain('no_template');
  expect(screen.getByText('A-1001')).not.toBeNull();
  expect(screen.getAllByText('Top Label').length).toBe(3);
  expect(screen.getByText('Unknown token {row}')).not.toBeNull();
});

it('shows the "only the first N are shown" note when errors exceed error_details', () => {
  render(<LabelRunErrorsModal run={run({ errors: 60 })} typeLabel={typeLabel} onClose={() => {}} />);
  expect(screen.getByText(/Only the first 3 of 60 errors are shown/)).not.toBeNull();
});

it('does not show the note when every error has a detail row', () => {
  render(<LabelRunErrorsModal run={run({})} typeLabel={typeLabel} onClose={() => {}} />);
  expect(screen.queryByText(/Only the first/)).toBeNull();
});

it('the footer Close button calls onClose', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<LabelRunErrorsModal run={run({})} typeLabel={typeLabel} onClose={onClose} />);
  await user.click(screen.getByText('Close', { selector: 'button.btn-ghost' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('Escape calls onClose', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<LabelRunErrorsModal run={run({})} typeLabel={typeLabel} onClose={onClose} />);
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});
