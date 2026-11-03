// @vitest-environment jsdom
/**
 * components/plans/PlanImportModal.tsx (More › Import…, and the empty
 * state's Import from MS Project or Excel): choose a file (MS Project
 * XML, Excel or CSV), which runs the dry run; review its rows (#, Task
 * Name, Action, Problems, how far the schedule moves it) under the
 * summary and the problems about the whole file; Import applies it with
 * the version the review saw, reloads the plan and ends on Done with what
 * was created. A file the API can't read stays on the first step with its
 * message; someone else's change between the review and the apply says
 * so and offers the review again.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { ImportRow, Plan, PlanImport } from '../../lib/plans/api';
import { flatTasks, makePlan } from '../../lib/plans/planFixtures';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ preferences: {} }) }));

const api = vi.hoisted(() => ({ importPlanFile: vi.fn(), importIntoNewPlan: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanImportModal, IMPORT_COLUMNS, IMPORT_WIDTH_PX } = await import('./PlanImportModal');
const { listGridStyle } = await import('../../lib/listTools');

const ROWS: ImportRow[] = [
  { index: 1, name: 'Survey', action: 'create', problems: [], moved_days: null },
  { index: 2, name: 'Pack', action: 'create', problems: ['No resource named “Pat Doe”, so it was left off.'],
    moved_days: 3 },
  { index: 3, name: 'Go live', action: 'create', problems: [], moved_days: -1.5 },
];
const PREVIEW: PlanImport = {
  rows: ROWS,
  problems: ['Kept this plan’s calendar: the file’s has no working time.',
    'Assignment 4 names no task, so it was skipped.'],
  summary: { created: 3, problems: 3 },
  version: 7,
};
const APPLIED: PlanImport = { ...PREVIEW, version: 8 };

const withTasks = (over: Partial<Plan> = {}) => makePlan({ id: 'p1', tasks: flatTasks(['a', 'b']), version: 7, ...over });
const emptyPlan = () => makePlan({ id: 'p1', tasks: [], project_finish: null, version: 7 });
const xml = (name = 'hall.xml', size?: number) => {
  const file = new File(['<Project/>'], name, { type: 'application/xml' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

function open(plan: Plan | null = withTasks()) {
  const ctl = { plan, reload: vi.fn(async () => {}) };
  const onClose = vi.fn();
  const view = render(<PlanImportModal ctl={ctl} initiativeId="init-1" onClose={onClose} />);
  return { ctl, onClose, view, user: userEvent.setup({ applyAccept: false }) };
}

const dialog = () => screen.getByRole('dialog', { name: 'Import from MS Project or Excel' });
const fileInput = () => within(dialog()).getByLabelText(/Drop your file here/) as HTMLInputElement;
const button = (name: string | RegExp) => within(dialog()).getByRole('button', { name });
/** The step indicator: each step's label and state. */
const steps = () => [...dialog().querySelectorAll('.rgm-step')].map((s) => {
  const state = s.classList.contains('on') ? 'on' : s.classList.contains('done') ? 'done' : '';
  return `${s.querySelector('.rgm-step-label')?.textContent}${state ? `:${state}` : ''}`;
});
/** The review table's rows: their cells' text. */
const tableRows = () => [...dialog().querySelectorAll('.dir-row .row-main')]
  .map((r) => [...r.children].map((c) => c.textContent));

beforeEach(() => {
  api.importPlanFile.mockReset();
  api.importIntoNewPlan.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the dialog', () => {
  it('a house plan dialog, extra wide, with the steps Choose file → Review → Done, the first on', () => {
    open();
    expect(dialog().classList.contains('pln-modal')).toBe(true);
    expect(dialog().classList.contains('pln-modal-xwide')).toBe(true);
    expect(within(dialog()).getByText('Project plan').className).toBe('eyebrow');
    expect(within(dialog()).getByRole('heading', { level: 3, name: 'Import from MS Project or Excel' })).not.toBeNull();
    expect(steps()).toEqual(['Choose file:on', 'Review', 'Done']);
    expect(fileInput().accept).toBe('.xml,.xlsx,.csv');
    // the file field takes the first focus
    expect(document.activeElement).toBe(fileInput());
  });

  it('the review table fits the dialog at its floors', () => {
    expect(listGridStyle(IMPORT_COLUMNS).minWidth).toBeLessThanOrEqual(IMPORT_WIDTH_PX);
    expect(IMPORT_COLUMNS.map((c) => c.label)).toEqual(['#', 'Task Name', 'Action', 'Problems', 'Schedule']);
  });
});

describe('choosing a file', () => {
  it('runs the dry run and shows the rows, their problems, how far they move, and the file’s problems', async () => {
    const { user } = open();
    api.importPlanFile.mockResolvedValueOnce(PREVIEW);
    const file = xml();
    await user.upload(fileInput(), file);
    expect(api.importPlanFile).toHaveBeenCalledWith('p1', file, { dryRun: true, mode: 'append' });
    expect(await within(dialog()).findByText('3 tasks will be created')).not.toBeNull();
    expect(steps()).toEqual(['Choose file:done', 'Review:on', 'Done']);
    expect(dialog().querySelector('.pln-import-sum')?.textContent).toBe('3 tasks will be created · 3 problems');
    const fileProblems = within(dialog()).getByRole('list', { name: 'About the whole file' });
    expect(within(fileProblems).getAllByRole('listitem').map((li) => li.textContent)).toEqual(PREVIEW.problems);
    expect([...dialog().querySelectorAll('.list-head .col-label')].map((h) => h.textContent?.trim()))
      .toEqual(['#', 'Task Name', 'Action', 'Problems', 'Schedule']);
    expect(tableRows()).toEqual([
      ['1', 'Survey', 'Create', '—', ''],
      ['2', 'Pack', 'Create', 'No resource named “Pat Doe”, so it was left off.', 'Moves 3 days later'],
      ['3', 'Go live', 'Create', '—', 'Moves 1.5 days earlier'],
    ]);
  });

  it('under StrictMode (the dev build mounts it twice) the review still lands', async () => {
    const ctl = { plan: withTasks(), reload: vi.fn(async () => {}) };
    render(<StrictMode><PlanImportModal ctl={ctl} initiativeId="init-1" onClose={() => {}} /></StrictMode>);
    api.importPlanFile.mockResolvedValueOnce(PREVIEW);
    await userEvent.setup().upload(fileInput(), xml());
    expect(await within(dialog()).findByText('3 tasks will be created')).not.toBeNull();
  });

  it('a plan with tasks takes the file’s tasks after its last one: no mode to choose', async () => {
    open();
    expect(within(dialog()).queryByRole('group', { name: 'How to import' })).toBeNull();
    expect(within(dialog()).getByText(/go after this plan’s last task/)).not.toBeNull();
  });

  it('an empty plan offers Add to the end or Fill this empty plan (the default), sent as the mode', async () => {
    const { user } = open(emptyPlan());
    const mode = within(dialog()).getByRole('group', { name: 'How to import' });
    const fill = within(mode).getByRole('button', { name: 'Fill this empty plan' });
    const append = within(mode).getByRole('button', { name: 'Add to the end' });
    expect(mode.classList.contains('segmented')).toBe(true);
    expect(fill.getAttribute('aria-pressed')).toBe('true');
    expect(fill.classList.contains('on')).toBe(true);
    expect(append.getAttribute('aria-pressed')).toBe('false');
    api.importPlanFile.mockResolvedValue(PREVIEW);
    await user.upload(fileInput(), xml());
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', expect.any(File), { dryRun: true, mode: 'fill' });
    // back to the file, the other mode, the review again
    await user.click(await within(dialog()).findByRole('button', { name: 'Back' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Add to the end' }));
    await user.click(button('Review'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', expect.any(File), { dryRun: true, mode: 'append' });
    await within(dialog()).findByText('3 tasks will be created');
  });

  it('a file the API can’t read stays on the first step with its message', async () => {
    const { user } = open();
    api.importPlanFile.mockRejectedValueOnce(new ApiError(422, 'bad_file', {
      code: 'bad_file',
      message: 'Excel 97-2003 workbooks (.xls) can’t be read, so save it as an Excel Workbook (.xlsx) first.',
    }));
    await user.upload(fileInput(), xml('old.xls'));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      'Excel 97-2003 workbooks (.xls) can’t be read, so save it as an Excel Workbook (.xlsx) first.');
    expect(steps()).toEqual(['Choose file:on', 'Review', 'Done']);
    expect(dialog().querySelector('.dir-list')).toBeNull();
  });

  it('a file over 20 MB is refused before it is sent', async () => {
    const { user } = open();
    await user.upload(fileInput(), xml('huge.xml', 20 * 1024 * 1024 + 1));
    expect(within(dialog()).getByRole('alert').textContent)
      .toBe('The file is larger than 20 MB, the most an import takes.');
    expect(api.importPlanFile).not.toHaveBeenCalled();
  });

  it('a file with no tasks: the review says so and Import stays off', async () => {
    const { user } = open();
    api.importPlanFile.mockResolvedValueOnce({ rows: [], problems: [], summary: { created: 0, problems: 0 }, version: 7 });
    await user.upload(fileInput(), xml());
    expect(await within(dialog()).findByText('The file has no tasks to import.')).not.toBeNull();
    expect((button(/^Import/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('importing', () => {
  async function reviewed(plan: Plan | null = withTasks()) {
    const opened = open(plan);
    const preview = plan ? api.importPlanFile : api.importIntoNewPlan;
    preview.mockResolvedValueOnce(plan ? PREVIEW : { ...PREVIEW, version: null });
    const file = xml();
    await opened.user.upload(fileInput(), file);
    await within(dialog()).findByText('3 tasks will be created');
    return { ...opened, file };
  }

  it('applies with the version the review saw, reloads the plan and ends on Done with what was created', async () => {
    const { user, ctl, onClose, file } = await reviewed();
    let finish: (out: PlanImport) => void = () => {};
    api.importPlanFile.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await user.click(button('Import 3 tasks'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', file, { dryRun: false, mode: 'append', baseVersion: 7 });
    // while it applies, nothing closes it
    expect((button('Importing…') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(APPLIED); });
    expect(ctl.reload).toHaveBeenCalledTimes(1);
    expect(steps()).toEqual(['Choose file:done', 'Review:done', 'Done:on']);
    expect(dialog().querySelector('.pln-import-sum')?.textContent).toBe('3 tasks created · 3 problems');
    // what was created, row by row (the apply's own answer)
    expect(tableRows().map((r) => r.slice(0, 3))).toEqual([
      ['1', 'Survey', 'Created'], ['2', 'Pack', 'Created'], ['3', 'Go live', 'Created']]);
    expect(button('Download summary (.csv)')).not.toBeNull();
    await user.click(button('Done'));
    expect(onClose).toHaveBeenCalled();
  });

  it('the summary downloads as CSV', async () => {
    const { user } = await reviewed();
    api.importPlanFile.mockResolvedValueOnce(APPLIED);
    await user.click(button('Import 3 tasks'));
    await within(dialog()).findByText('3 tasks created');
    const blobs: Blob[] = [];
    Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(button('Download summary (.csv)'));
    expect((await blobs[0].text()).split('\n')).toEqual([
      '#,Task Name,Action,Problems,Schedule',
      '1,Survey,Created,,',
      '2,Pack,Created,"No resource named “Pat Doe”, so it was left off.",Moves 3 days later',
      '3,Go live,Created,,Moves 1.5 days earlier',
    ]);
  });

  it('someone else changed the plan after the review: says so, reloads it, and Review again starts over', async () => {
    const { user, ctl } = await reviewed();
    api.importPlanFile.mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed', version: 8 }));
    await user.click(button('Import 3 tasks'));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      'Someone else changed this plan after the review, so review the file again before importing.');
    expect(ctl.reload).toHaveBeenCalledTimes(1);
    expect((button('Import 3 tasks') as HTMLButtonElement).disabled).toBe(true);
    api.importPlanFile.mockResolvedValueOnce({ ...PREVIEW, version: 8 });
    await user.click(button('Review again'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', expect.any(File), { dryRun: true, mode: 'append' });
    await waitFor(() => expect(within(dialog()).queryByRole('alert')).toBeNull());
    api.importPlanFile.mockResolvedValueOnce(APPLIED);
    await user.click(button('Import 3 tasks'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', expect.any(File),
      { dryRun: false, mode: 'append', baseVersion: 8 });
  });

  it('a locked plan’s refusal shows on the review, which stays', async () => {
    const { user } = await reviewed();
    api.importPlanFile.mockRejectedValueOnce(new ApiError(409, 'plan_locked', { code: 'plan_locked' }));
    await user.click(button('Import 3 tasks'));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      'The schedule is locked, so only progress can be updated until someone unlocks it.');
    expect(steps()).toEqual(['Choose file:done', 'Review:on', 'Done']);
  });

  it('a new plan: the initiative’s route, always a fill; Done shows the plan reloaded', async () => {
    const { user, ctl, file } = await reviewed(null);
    expect(api.importIntoNewPlan).toHaveBeenCalledWith('init-1', file, { dryRun: true });
    api.importIntoNewPlan.mockResolvedValueOnce({ ...APPLIED, version: 1 });
    await user.click(button('Import 3 tasks'));
    expect(api.importIntoNewPlan).toHaveBeenLastCalledWith('init-1', file, { dryRun: false });
    await within(dialog()).findByText('3 tasks created');
    expect(ctl.reload).toHaveBeenCalledTimes(1);
    expect(api.importPlanFile).not.toHaveBeenCalled();
  });

  it('the review says how the file goes in: after the last task, or filling the empty plan', async () => {
    await reviewed();
    const sum = dialog().querySelector('.pln-import-sum');
    expect(sum?.nextElementSibling?.textContent).toBe('Adds after the last task');
    cleanup();
    await reviewed(emptyPlan());
    expect(within(dialog()).getByText('Fills this empty plan').className).toBe('pln-note');
    expect(within(dialog()).queryByText('Adds after the last task')).toBeNull();
  });

  it('the review keeps the mode it previewed when the plan reloads under it, and applies that one', async () => {
    const { user, ctl, view, file } = await reviewed(emptyPlan());
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', file, { dryRun: true, mode: 'fill' });
    // someone adds a task meanwhile and the plan reloads: no longer empty
    view.rerender(<PlanImportModal ctl={{ ...ctl, plan: withTasks() }} initiativeId="init-1" onClose={() => {}} />);
    expect(within(dialog()).getByText('Fills this empty plan')).not.toBeNull();
    api.importPlanFile.mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed', version: 8 }));
    await user.click(button('Import 3 tasks'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', file, { dryRun: false, mode: 'fill', baseVersion: 7 });
    // reviewing again previews the plan as it is now
    await within(dialog()).findByText(/review the file again/);
    api.importPlanFile.mockResolvedValueOnce({ ...PREVIEW, version: 8 });
    await user.click(button('Review again'));
    expect(api.importPlanFile).toHaveBeenLastCalledWith('p1', file, { dryRun: true, mode: 'append' });
    expect(await within(dialog()).findByText('Adds after the last task')).not.toBeNull();
  });

  it('a new plan’s review has no mode line: the file makes the plan', async () => {
    await reviewed(null);
    expect(within(dialog()).queryByText('Fills this empty plan')).toBeNull();
    expect(within(dialog()).queryByText('Adds after the last task')).toBeNull();
  });

  it('a new plan has no mode to choose, and says it takes the file’s calendar and start', () => {
    open(null);
    expect(within(dialog()).queryByRole('group', { name: 'How to import' })).toBeNull();
    expect(within(dialog()).getByText(/takes the file’s calendar, project start and status date/)).not.toBeNull();
  });
});

describe('a large file', () => {
  // jsdom does no layout: a 600px dialog that scrolls, rows of 58px
  const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 58 });
  });
  afterEach(() => {
    if (realOffset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffset);
  });

  it('a 1,500-task review draws a window of its rows, not all of them', async () => {
    const { user } = open();
    const rows = Array.from({ length: 1500 }, (_, i): ImportRow => ({
      index: i + 1, name: `Task ${i + 1}`, action: 'create', problems: [], moved_days: null,
    }));
    api.importPlanFile.mockResolvedValueOnce({ rows, problems: [], summary: { created: 1500, problems: 0 }, version: 7 });
    await user.upload(fileInput(), xml());
    expect(await within(dialog()).findByText('1,500 tasks will be created')).not.toBeNull();
    const drawn = dialog().querySelectorAll('.dir-row').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
  });
});
