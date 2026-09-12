// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelRun } from '../../lib/api';
import GenerationProgress from './GenerationProgress';

afterEach(cleanup);

const run = (over: Partial<LabelRun>): LabelRun => ({
  id: 'r1', initiative_id: 'i1', initiative_name: 'NAP11', label_types: ['top', 'front'],
  regenerate_existing: false, status: 'running', cancel_requested: false,
  current_label_type: 'top', current_item: 'A-1001', total: 100, processed: 40,
  generated: 38, skipped: 1, errors: 1, error_summary: {}, error_details: [], error: null,
  requested_by: 'p1', requested_by_name: 'Alice', notify: false,
  created_at: '2026-09-11T00:00:00Z', started_at: '2026-09-11T00:00:01Z', finished_at: null,
  progress_pct: 40, ...over,
});
const typeLabel = (key: string) => (key === 'top' ? 'Top Label' : key);

it('shows status chip, processing message with the current type and processed/total, and progress bar', () => {
  render(<GenerationProgress run={run({})} typeLabel={typeLabel} />);
  expect(screen.getByText('Generating')).not.toBeNull();
  expect(screen.getByText(/Processing Top Label · 40 \/ 100/)).not.toBeNull();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
  expect(screen.getByText('Current: A-1001')).not.toBeNull();
});

it('shows live counters', () => {
  render(<GenerationProgress run={run({})} typeLabel={typeLabel} />);
  expect(screen.getByText('38')).not.toBeNull();
  expect(screen.getAllByText('1', { selector: '.dash-kpi-value' }).length).toBe(2);   // skipped and errors
});

it('queued run shows the paused message when workers are paused', () => {
  render(<GenerationProgress run={run({ status: 'queued', current_label_type: null })}
                              typeLabel={typeLabel} paused />);
  expect(screen.getByText(/Paused for maintenance/)).not.toBeNull();
});

it('failed run shows the error message, no cancel button', () => {
  render(<GenerationProgress run={run({ status: 'failed', error: 'Boom' })} typeLabel={typeLabel}
                              onCancel={() => {}} />);
  expect(screen.getByText('Boom')).not.toBeNull();
  expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
});

it('Cancel button calls onCancel while active, and disables once cancel_requested', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(<GenerationProgress run={run({})} typeLabel={typeLabel} onCancel={onCancel} />);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
  cleanup();
  render(<GenerationProgress run={run({ cancel_requested: true })} typeLabel={typeLabel} onCancel={onCancel} />);
  expect((screen.getByRole('button', { name: 'Canceling…' }) as HTMLButtonElement).disabled).toBe(true);
});
