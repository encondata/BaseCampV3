// @vitest-environment jsdom
/**
 * GenerateReportModal for the Project plan PDF: from the plan (an initial
 * initiative skips the pick step) and from the Reports page (pick, then the
 * plan is fetched); Generate queues the run with the options step's
 * choices; a refusal says why; the finished file stays on the run.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, ReportDefinition, ReportRun } from '../../lib/api';
import { flatTasks, makePlan } from '../../lib/plans/planFixtures';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ preferences: { list_size: 'default' } }) }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { read_only: false, read_only_message: '', workers_paused: false, banner: null }, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), createReportRun: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), setReportRunNotify: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const plans = vi.hoisted(() => ({ getPlan: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()), ...plans,
}));

const { ApiError } = await import('../../lib/api');
const { default: GenerateReportModal } = await import('./GenerateReportModal');

const DEF: ReportDefinition = {
  id: 'd-plan', name: 'Project plan', description: 'The plan as a PDF.', report_type: 'project_plan',
  is_system: true, updated_at: '2026-10-28T10:00:00Z', options: {},
};
const PLAN = makePlan({ tasks: flatTasks(['a', 'b', 'c']), initiative_id: 'init-1', initiative_name: 'NAP11' });
const INI = {
  id: 'init-1', name: 'NAP11', status: 'in_progress', status_label: 'In progress', status_color: '#000',
  initiative_type: 'move', type_label: 'Move', type_color: '#000', client_name: 'Acme', archived_at: null,
  scheduled_start: '2026-11-01T00:00:00Z', scheduled_end: null,
} as unknown as InitiativeItem;
const run = (over: Partial<ReportRun> = {}): ReportRun => ({
  id: 'r1', definition_id: 'd-plan', definition_name: 'Project plan', report_type: 'project_plan',
  initiative_id: 'init-1', initiative_name: 'NAP11', options: {}, status: 'queued', error: null,
  requested_by: 'p1', requested_by_name: 'Jimmy', requested_rank: 60, notify: false, filename: null,
  size_bytes: null, started_at: null, finished_at: null, created_at: '2026-11-03T12:00:00Z', ...over,
});

beforeEach(() => {
  api.listInitiatives.mockResolvedValue([INI]);
  api.createReportRun.mockResolvedValue(run({ status: 'completed', filename: 'NAP11 - Project plan - 2026-11-03 0900.pdf' }));
  api.getReportRun.mockResolvedValue(run());
  plans.getPlan.mockResolvedValue(PLAN);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('from the plan: no pick step, the plan’s initiative, and Generate queues its choices', async () => {
  const user = userEvent.setup();
  render(<GenerateReportModal definition={DEF} onClose={() => {}}
                              initialInitiative={{ id: 'init-1', name: 'NAP11' }}
                              projectPlan={{ plan: PLAN, initial: { columns: ['id', 'name', 'duration'], zoom: 'days', critical: false, baseline: true } }} />);
  expect(screen.queryByText('Initiative')).toBeNull();
  expect(screen.getByRole('group', { name: 'Timescale' })).toBeTruthy();
  expect(api.listInitiatives).not.toHaveBeenCalled();
  expect(plans.getPlan).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(api.createReportRun).toHaveBeenCalledWith({
    definition_id: 'd-plan', initiative_id: 'init-1', notify: false,
    options: {
      columns: ['id', 'name', 'duration'], zoom: 'days', paper: 'letter', include_completed: true,
      show_critical: false, show_baseline: true,
    },
  });
  expect(await screen.findByText('NAP11 - Project plan - 2026-11-03 0900.pdf')).toBeTruthy();
  // a plan's PDF isn't attached to the initiative's Files
  expect(screen.queryByText(/saved to the initiative/)).toBeNull();
});

it('from the Reports page: pick the initiative, its plan loads, and a 404 says it has none', async () => {
  const user = userEvent.setup();
  render(<GenerateReportModal definition={DEF} onClose={() => {}} />);
  await user.click(await screen.findByLabelText('NAP11'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText(/About \d+ pages/)).toBeTruthy();
  expect(plans.getPlan).toHaveBeenCalledWith('init-1');
  api.createReportRun.mockRejectedValueOnce(new ApiError(404, 'plan_not_found', { code: 'plan_not_found' }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(await screen.findByText('This initiative has no project plan yet.')).toBeTruthy();
  expect(within(document.querySelector('.modal-foot') as HTMLElement).getByRole('button', { name: 'Close' }))
    .toBeTruthy();
});
