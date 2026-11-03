// @vitest-environment jsdom
/**
 * The plan tab's dialogs end to end (PlanTab + usePlan against a mocked
 * lib/plans/api): Task Information from Shift+F2, a row number's
 * double-click and the toolbar's Notes; Set baseline (and replacing one,
 * dated); Clear baseline and Lock asking first; Update project and Plan
 * settings from More; Delete plan behind the typed initiative name; and
 * someone else's change closing a dialog quietly.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { longDate } from '../../lib/format';
import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import { saveColumnPrefs } from '../../lib/plans/columns';
import { flatTasks, makeLink, makeOpsResult, makePlan } from '../../lib/plans/planFixtures';
import { findSheet } from './planTabTesting';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string) => resource === 'project_plans',
    person: { id: 'p-me', display_name: 'Jimmy Henderson' },
    preferences: {},
  }),
}));

const api = vi.hoisted(() => ({
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  postOps: vi.fn(),
  patchPlan: vi.fn(),
  lockPlan: vi.fn(),
  unlockPlan: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  updateProject: vi.fn(),
  getPlanVersion: vi.fn(),
  listPlanTemplates: vi.fn(),
  saveAsTemplate: vi.fn(),
  patchPlanTemplate: vi.fn(),
  deletePlanTemplate: vi.fn(),
  importPlanFile: vi.fn(),
  exportPlan: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanTab } = await import('./PlanTab');
const { BASELINE_SET } = await import('./usePlanCommands');
const { BASELINE_CLEARED, LOCK_DESCRIPTION } = await import('./PlanConfirmModals');
const { PLAN_DELETED } = await import('./DeletePlanModal');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };

function tasks3(): PlanTask[] {
  const [a, b, c] = flatTasks(['a', 'b', 'c']);
  return [{ ...a, name: 'Survey' }, { ...b, name: 'Pack', predecessors: '1' }, { ...c, name: 'Go live' }];
}
const plan3 = (over: Partial<Plan> = {}) => makePlan({ tasks: tasks3(), links: [makeLink('l1', 'a', 'b')], ...over });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const rowOf = (name: string) => within(grid()).getAllByRole('row')
  .find((r) => r.querySelector('[data-col="name"]')?.textContent === name) as HTMLElement;
const cellOf = (name: string, col: string) => rowOf(name).querySelector(`[data-col="${col}"]`) as HTMLElement;
const tool = (name: string) => within(screen.getByRole('toolbar', { name: 'Project plan' })).getByRole('button', { name });
const dialogNamed = (name: string) => screen.findByRole('dialog', { name });

async function ready(plan: Plan = plan3()) {
  api.getPlan.mockResolvedValueOnce(plan);
  const user = userEvent.setup();
  renderTab();
  await findSheet();
  return user;
}

async function more(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: item }));
}

const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const key of SIZES) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => (key.endsWith('Width') ? 1200 : 600) });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  SIZES.forEach((key, i) => {
    const real = realSizes[i];
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });
  localStorage.clear();
});

describe('Task Information', () => {
  it('Shift+F2 opens it for the selected task; OK sends one batch', async () => {
    const user = await ready();
    await user.click(cellOf('Go live', 'name'));
    fireEvent.keyDown(grid(), { key: 'F2', shiftKey: true });
    const dialog = await dialogNamed('Task Information');
    const name = within(dialog).getByLabelText('Task Name');
    expect(document.activeElement).toBe(name);
    await user.type(name, '!');
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(api.postOps.mock.calls[0][2] as Op[]).toEqual([{ op: 'update_task', id: 'c', fields: { name: 'Go live!' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a double-click on a row’s number opens it', async () => {
    const user = await ready();
    await user.dblClick(cellOf('Pack', 'id'));
    const dialog = await dialogNamed('Task Information');
    expect((within(dialog).getByLabelText('Task Name') as HTMLInputElement).value).toBe('Pack');
  });

  it('the toolbar’s Notes opens it on the Notes tab, focus in the note', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    await user.click(tool('Notes'));
    const dialog = await dialogNamed('Task Information');
    expect(within(dialog).getByRole('button', { name: 'Notes' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Notes'));
  });
});

describe('baseline', () => {
  it('Set baseline sends at once when there is none, and says so', async () => {
    const user = await ready();
    api.setBaseline.mockResolvedValueOnce(plan3({ version: 6, baseline_set_at: '2026-10-28T15:00:00Z' }));
    await more(user, 'Set baseline…');
    await waitFor(() => expect(api.setBaseline).toHaveBeenCalledWith('plan-1', false));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(BASELINE_SET));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('one already there: "Replace the baseline set on <date>?", then replace', async () => {
    const user = await ready();
    const setAt = '2026-10-20T14:00:00Z';
    api.setBaseline.mockRejectedValueOnce(new ApiError(409, 'baseline_exists', { code: 'baseline_exists', set_at: setAt }));
    await more(user, 'Set baseline…');
    const dialog = await dialogNamed(`Replace the baseline set on ${longDate(setAt)}?`);
    api.setBaseline.mockResolvedValueOnce(plan3({ version: 6, baseline_set_at: '2026-10-28T15:00:00Z' }));
    await user.click(within(dialog).getByRole('button', { name: 'Replace baseline' }));
    await waitFor(() => expect(api.setBaseline).toHaveBeenLastCalledWith('plan-1', true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast).toHaveBeenCalledWith(BASELINE_SET);
  });

  it('Clear baseline asks first, saying it can’t be undone', async () => {
    const user = await ready(plan3({ baseline_set_at: '2026-10-20T14:00:00Z' }));
    await more(user, 'Clear baseline…');
    const dialog = await dialogNamed('Clear the baseline?');
    expect(within(dialog).getByText(/can’t be undone/)).toBeTruthy();
    expect(api.clearBaseline).not.toHaveBeenCalled();
    api.clearBaseline.mockResolvedValueOnce(plan3({ version: 6, baseline_set_at: null }));
    const clear = within(dialog).getByRole('button', { name: 'Clear baseline' });
    expect(clear.className).toContain('btn-danger');
    await user.click(clear);
    await waitFor(() => expect(api.clearBaseline).toHaveBeenCalledWith('plan-1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(BASELINE_CLEARED));
  });
});

describe('lock', () => {
  it('Lock schedule asks with the lock’s rule; the banner follows', async () => {
    const user = await ready();
    await more(user, 'Lock schedule…');
    const dialog = await dialogNamed('Lock the schedule?');
    expect(within(dialog).getByText(LOCK_DESCRIPTION)).toBeTruthy();
    api.lockPlan.mockResolvedValueOnce(plan3({ version: 6, locked_at: '2026-10-28T15:00:00Z', locked_by_name: 'Jimmy Henderson' }));
    await user.click(within(dialog).getByRole('button', { name: 'Lock schedule' }));
    await waitFor(() => expect(api.lockPlan).toHaveBeenCalledWith('plan-1'));
    expect(await screen.findByRole('status', { name: 'Schedule locked' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('someone else’s change closes it quietly (the plan reloads)', async () => {
    const user = await ready();
    await more(user, 'Lock schedule…');
    const dialog = await dialogNamed('Lock the schedule?');
    api.lockPlan.mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed', version: 9 }));
    api.getPlan.mockResolvedValueOnce(plan3({ version: 9 }));
    await user.click(within(dialog).getByRole('button', { name: 'Lock schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(document.body).queryByRole('alert')).toBeNull();
  });
});

describe('Update project, Plan settings, Delete plan', () => {
  it('a More dialog closing with nothing under it hands focus back to the sheet, selecting nothing', async () => {
    const user = await ready();
    await more(user, 'Update project…');
    await user.click(within(await dialogNamed('Update project')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(grid()));
    expect(within(grid()).queryAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toEqual([]);
    await more(user, 'Keyboard shortcuts');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(grid()));
  });

  it('More opens Save as template (posting this plan) and Templates', async () => {
    const user = await ready();
    await more(user, 'Save as template…');
    const save = await dialogNamed('Save as template');
    await user.type(within(save).getByLabelText('Name'), 'Hall move');
    api.saveAsTemplate.mockResolvedValueOnce({ id: 't1', name: 'Hall move' });
    await user.click(within(save).getByRole('button', { name: 'Save template' }));
    expect(api.saveAsTemplate).toHaveBeenCalledWith(plan3().id, { name: 'Hall move', description: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast).toHaveBeenCalledWith('Template “Hall move” saved.');

    api.listPlanTemplates.mockResolvedValueOnce([{
      id: 't1', name: 'Hall move', description: null, task_count: 3, created_by_name: 'Jimmy Henderson',
      updated_at: '2026-11-02T15:00:00Z',
    }]);
    await more(user, 'Templates…');
    const list = await dialogNamed('Templates');
    expect(await within(list).findByText('Hall move')).not.toBeNull();
  });

  it('More › Import… adds a file’s tasks after the last one, and the plan reloads with them', async () => {
    const user = await ready();
    await more(user, 'Import…');
    const dialog = await dialogNamed('Import from MS Project or Excel');
    const out = {
      rows: [{ index: 1, name: 'Ship', action: 'create', problems: [], moved_days: null }],
      problems: [], summary: { created: 1, problems: 0 }, version: plan3().version,
    };
    api.importPlanFile.mockResolvedValueOnce(out);
    const file = new File(['ID,Task Name\n1,Ship\n'], 'more.csv', { type: 'text/csv' });
    await user.upload(within(dialog).getByLabelText(/Drop your file here/), file);
    expect(api.importPlanFile).toHaveBeenCalledWith(plan3().id, file, { dryRun: true, mode: 'append' });
    api.importPlanFile.mockResolvedValueOnce({ ...out, version: plan3().version + 1 });
    const four = [...tasks3(), { ...flatTasks(['a', 'b', 'c', 'd'])[3], name: 'Ship' }];
    api.getPlan.mockResolvedValueOnce(plan3({ tasks: four, version: plan3().version + 1 }));
    await user.click(await within(dialog).findByRole('button', { name: 'Import 1 task' }));
    expect(api.importPlanFile).toHaveBeenLastCalledWith(plan3().id, file,
      { dryRun: false, mode: 'append', baseVersion: plan3().version });
    await waitFor(() => expect(rowOf('Ship')).toBeTruthy());
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('More › Export › Excel downloads the sheet’s visible columns; MS Project XML the whole plan', async () => {
    saveColumnPrefs({ visible: ['id', 'name', 'duration', 'notes'], widths: {} });
    const user = await ready();
    api.exportPlan.mockResolvedValue('NAP11 Hall Migration - Project plan.xlsx');
    await more(user, 'Excel');
    expect(api.exportPlan).toHaveBeenLastCalledWith(plan3().id, 'xlsx', ['id', 'name', 'duration', 'notes'],
      `${plan3().initiative_name} - Project plan.xlsx`);
    await more(user, 'MS Project XML');
    expect(api.exportPlan).toHaveBeenLastCalledWith(plan3().id, 'xml', undefined,
      `${plan3().initiative_name} - Project plan.xml`);
    // a refusal says why
    api.exportPlan.mockRejectedValueOnce(new ApiError(404, 'plan_not_found', { code: 'plan_not_found' }));
    await more(user, 'MS Project XML');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This plan no longer exists, or you can’t see it.'));
  });

  it('More opens Update project and Plan settings', async () => {
    const user = await ready();
    await more(user, 'Update project…');
    await user.click(within(await dialogNamed('Update project')).getByRole('button', { name: 'Cancel' }));
    await more(user, 'Plan settings…');
    expect(await dialogNamed('Plan settings')).toBeTruthy();
  });

  it('Delete plan says what goes: the tasks and their links, and the baseline when there is one', async () => {
    const user = await ready();
    await more(user, 'Delete plan…');
    expect(within(await dialogNamed('Delete the project plan?'))
      .getByText('Its 3 tasks and their links go with it. This can’t be undone.')).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    cleanup();
    const again = await ready(plan3({ baseline_set_at: '2026-10-20T14:00:00Z' }));
    await more(again, 'Delete plan…');
    expect(within(await dialogNamed('Delete the project plan?'))
      .getByText('Its 3 tasks, their links and the baseline go with it. This can’t be undone.')).toBeTruthy();
  });

  it('Delete plan turns on only for the initiative’s exact name; then the empty state', async () => {
    const user = await ready();
    await more(user, 'Delete plan…');
    const dialog = await dialogNamed('Delete the project plan?');
    const remove = within(dialog).getByRole('button', { name: 'Delete plan' }) as HTMLButtonElement;
    expect(remove.className).toContain('btn-danger');
    expect(remove.disabled).toBe(true);
    const field = within(dialog).getByLabelText('Initiative name');
    await user.type(field, 'nap11 hall migration');
    expect(remove.disabled).toBe(true);
    await user.clear(field);
    await user.type(field, INITIATIVE.name);
    expect(remove.disabled).toBe(false);
    api.deletePlan.mockResolvedValueOnce(undefined);
    await user.click(remove);
    await waitFor(() => expect(api.deletePlan).toHaveBeenCalledWith('init-1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(PLAN_DELETED));
    expect(screen.queryByRole('grid')).toBeNull();
  });
});
