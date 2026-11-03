// @vitest-environment jsdom
/**
 * GenerateReportModal's options step for the Project plan PDF: the sheet's
 * columns (Current view / Default / Choose…), the date range, the
 * timescale, the paper, the three switches, and the page estimate that
 * follows them.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportDefinition } from '../../lib/api';
import type { Plan } from '../../lib/plans/api';
import { DEFAULT_VISIBLE } from '../../lib/plans/columns';
import { estimatePages, estimateText } from '../../lib/plans/planPdf';
import { flatTasks, makePlan } from '../../lib/plans/planFixtures';

const plans = vi.hoisted(() => ({ getPlan: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()), ...plans,
}));

const { ApiError } = await import('../../lib/api');
const { default: ProjectPlanOptions } = await import('./ProjectPlanOptions');

const DEF: ReportDefinition = {
  id: 'd-plan', name: 'Project plan', description: 'The plan as a PDF.', report_type: 'project_plan',
  is_system: true, updated_at: '2026-10-28T10:00:00Z', options: {},
};
const INITIATIVE = { id: 'init-1', name: 'NAP11 Hall Migration' };

function plan40(over: Partial<Plan> = {}): Plan {
  const tasks = flatTasks(Array.from({ length: 40 }, (_, i) => `t${i + 1}`))
    .map((t, i) => ({ ...t, percent_complete: i < 10 ? 100 : 0 }));
  return makePlan({ tasks, project_start: '2026-11-02T08:00', project_finish: '2027-01-29T17:00', ...over });
}

const CURRENT = ['id', 'name', 'duration', 'start', 'finish', 'notes'];

function renderOptions(props: Partial<Parameters<typeof ProjectPlanOptions>[0]> = {}) {
  const onGenerate = vi.fn();
  render(<ProjectPlanOptions definition={DEF} initiative={INITIATIVE} plan={plan40()}
                             initial={{ columns: CURRENT, zoom: 'weeks', critical: true, baseline: false }}
                             onGenerate={onGenerate} {...props} />);
  return { onGenerate, user: userEvent.setup() };
}

const generate = () => screen.getByRole('button', { name: 'Generate Report' });
const group = (name: string) => screen.getByRole('group', { name });
const pressed = (name: string) => within(group(name)).getAllByRole('button')
  .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

beforeEach(() => { plans.getPlan.mockReset(); });
afterEach(() => { cleanup(); });

describe('ProjectPlanOptions', () => {
  it('opens on the view the plan is in, and Generate sends it', async () => {
    const { onGenerate, user } = renderOptions();
    expect(pressed('Columns')).toEqual(['Current view']);
    expect(pressed('Date range')).toEqual(['Whole project']);
    expect(pressed('Timescale')).toEqual(['Weeks']);
    expect(pressed('Paper')).toEqual(['Letter']);
    expect((screen.getByLabelText('Show critical path') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Show baseline') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Include completed tasks') as HTMLInputElement).checked).toBe(true);
    await user.click(generate());
    expect(onGenerate).toHaveBeenCalledWith({
      initiative_id: 'init-1',
      options: {
        columns: CURRENT, zoom: 'weeks', paper: 'letter', include_completed: true, show_critical: true,
        show_baseline: false,
      },
      notify: false,
    });
  });

  it('Default prints the sheet’s default columns; Choose… picks them', async () => {
    const { onGenerate, user } = renderOptions();
    await user.click(within(group('Columns')).getByRole('button', { name: 'Default' }));
    await user.click(generate());
    expect(onGenerate.mock.lastCall?.[0].options.columns).toEqual([...DEFAULT_VISIBLE]);
    await user.click(within(group('Columns')).getByRole('button', { name: 'Choose…' }));
    expect(screen.getByText('ID and Task Name are always printed.')).toBeTruthy();
    // the picks start from the current view: Duration, Start, Finish, Notes
    await user.click(screen.getByRole('button', { name: 'Remove Notes' }));
    await user.click(generate());
    expect(onGenerate.mock.lastCall?.[0].options.columns).toEqual(['id', 'name', 'duration', 'start', 'finish']);
  });

  it('Custom range adds from and to, starting from the project’s days', async () => {
    const { onGenerate, user } = renderOptions();
    await user.click(within(group('Date range')).getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect([from.value, to.value]).toEqual(['2026-11-02', '2027-01-29']);
    await user.clear(to);
    await user.type(to, '2026-12-31');
    await user.click(generate());
    expect(onGenerate.mock.lastCall?.[0].options).toMatchObject({ from: '2026-11-02', to: '2026-12-31' });
    // a range that ends before it starts can't be sent
    await user.clear(to);
    await user.type(to, '2026-10-01');
    expect(screen.getByText('Choose a From date on or before the To date.')).toBeTruthy();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
  });

  it('the estimate follows the timescale, the paper and the completed tasks', async () => {
    const { onGenerate, user } = renderOptions();
    const range = { start: '2026-11-02T08:00', finish: '2027-01-29T17:00' };
    const text = (zoom: 'fit' | 'days' | 'weeks', paper: 'letter' | 'a4' = 'letter', rows = 40) =>
      estimateText(estimatePages({ rows, ...range, zoom, paper }));
    expect(screen.getByText(text('weeks'))).toBeTruthy();
    await user.click(within(group('Timescale')).getByRole('button', { name: 'Days' }));
    expect(screen.getByText(text('days'))).toBeTruthy();
    expect(text('days')).not.toBe(text('weeks'));
    await user.click(within(group('Timescale')).getByRole('button', { name: 'Fit' }));
    expect(screen.getByText(text('fit'))).toBeTruthy();
    expect(screen.getByText(/Fit draws it by months/)).toBeTruthy();
    await user.click(within(group('Paper')).getByRole('button', { name: 'A4' }));
    await user.click(screen.getByLabelText('Include completed tasks'));
    expect(screen.getByText(text('fit', 'a4', 30))).toBeTruthy();
    await user.click(generate());
    expect(onGenerate.mock.lastCall?.[0].options).toMatchObject({ zoom: 'fit', paper: 'a4', include_completed: false });
  });

  it('days wholly outside the plan can’t be sent; days past it are cut to it', async () => {
    const { onGenerate, user } = renderOptions();
    await user.click(within(group('Date range')).getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    await user.clear(from);
    await user.type(from, '2027-03-01');
    await user.clear(to);
    await user.type(to, '2027-03-31');
    expect(screen.getByText(/^The dates are outside this plan’s tasks\. The plan runs Mon 11\/2\/26 → Fri 1\/29\/27\.$/))
      .toBeTruthy();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
    // reaching back into the plan: the estimate is the plan's own days from Jan 1
    await user.clear(from);
    await user.type(from, '2027-01-01');
    expect(screen.queryByText(/outside this plan/)).toBeNull();
    expect(screen.getByText(estimateText(estimatePages({
      rows: 40, start: '2027-01-01T00:00', finish: '2027-01-29T17:00', zoom: 'weeks', paper: 'letter',
    })))).toBeTruthy();
    await user.click(generate());
    expect(onGenerate).toHaveBeenCalled();
  });

  it('a plan over ten years prints ten years of it at most', async () => {
    const long = plan40({ project_finish: '2037-06-01T17:00' });
    const { onGenerate, user } = renderOptions({ plan: long });
    expect(screen.getByText('The date range can be at most 10 years.')).toBeTruthy();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(group('Date range')).getByRole('button', { name: 'Custom' }));
    const to = screen.getByLabelText('To') as HTMLInputElement;
    await user.clear(to);
    await user.type(to, '2036-11-01');
    expect(screen.queryByText('The date range can be at most 10 years.')).toBeNull();
    await user.click(generate());
    expect(onGenerate.mock.lastCall?.[0].options).toMatchObject({ from: '2026-11-02', to: '2036-11-01' });
    await user.clear(to);
    await user.type(to, '2036-11-02');
    expect(screen.getByText('The date range can be at most 10 years.')).toBeTruthy();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
  });

  it('the hours zoom isn’t offered: it opens on Fit', () => {
    renderOptions({ initial: { columns: CURRENT, zoom: 'hours' } });
    expect(pressed('Timescale')).toEqual(['Fit']);
  });

  it('from the Reports page it loads the initiative’s plan; one without says so', async () => {
    plans.getPlan.mockResolvedValueOnce(plan40());
    const first = renderOptions({ plan: undefined, initial: undefined });
    expect(await screen.findByText(estimateText(estimatePages({
      rows: 40, start: '2026-11-02T08:00', finish: '2027-01-29T17:00', zoom: 'fit', paper: 'letter',
    })))).toBeTruthy();
    expect(plans.getPlan).toHaveBeenCalledWith('init-1');
    await first.user.click(generate());
    expect(first.onGenerate).toHaveBeenCalled();
    cleanup();

    plans.getPlan.mockRejectedValueOnce(new ApiError(404, 'no_plan', { code: 'no_plan' }));
    const second = renderOptions({ plan: undefined, initial: undefined });
    expect(await screen.findByText('This initiative has no project plan yet.')).toBeTruthy();
    expect((generate() as HTMLButtonElement).disabled).toBe(true);
    await second.user.click(generate());
    expect(second.onGenerate).not.toHaveBeenCalled();
  });
});
