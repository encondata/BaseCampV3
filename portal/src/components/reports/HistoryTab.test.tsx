// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportRun } from '../../lib/api';

const api = vi.hoisted(() => ({
  listReportRuns: vi.fn(), getReportRun: vi.fn(), getReportRunDownloadUrl: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: HistoryTab } = await import('./HistoryTab');

const run = (over: Partial<ReportRun>): ReportRun => ({
  id: 'r1', definition_id: 'd1', definition_name: 'Site & Move Survey',
  report_type: 'site_move_survey', initiative_id: null, initiative_name: null,
  options: {}, status: 'completed', error: null, requested_by: 'p1',
  requested_by_name: 'Alice', requested_rank: 40, notify: false,
  filename: 'Site & Move Survey - Acme - 2026-09-10 1200.xlsx', size_bytes: 2048,
  started_at: '2026-09-10T12:00:00Z', finished_at: '2026-09-10T12:00:05Z',
  created_at: '2026-09-10T12:00:00Z', ...over,
});

beforeEach(() => {
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/x.xlsx');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows "—" (not a link) for a run with a null initiative', async () => {
  api.listReportRuns.mockResolvedValue([run({})]);
  render(<MemoryRouter><HistoryTab highlightRunId={null} onCount={() => {}} /></MemoryRouter>);
  await screen.findByText('Site & Move Survey');
  expect(screen.getByText('—')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

it('still links to the initiative when one is present', async () => {
  api.listReportRuns.mockResolvedValue([run({
    initiative_id: 'i1', initiative_name: 'Champagne Move', definition_name: 'Move Report',
  })]);
  render(<MemoryRouter><HistoryTab highlightRunId={null} onCount={() => {}} /></MemoryRouter>);
  const link = await screen.findByRole('link', { name: 'Champagne Move' });
  expect(link.getAttribute('href')).toBe('/initiatives/i1');
});
