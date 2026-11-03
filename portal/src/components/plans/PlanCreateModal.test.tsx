// @vitest-environment jsdom
/**
 * components/plans/PlanCreateModal.tsx and its template picker: opened from
 * "From a template" a template is required and sent as `template_id`;
 * from "Blank plan" the picker is optional and nothing is sent unless one
 * is picked. A template deleted meanwhile (404 template_not_found) says
 * so and reloads the list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { PlanTemplate } from '../../lib/plans/api';
import { PLAN_ERRORS } from '../../lib/plans/errors';
import type { PlanController } from './usePlan';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({ listPlanTemplates: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanCreateModal } = await import('./PlanCreateModal');

const HALL: PlanTemplate = {
  id: 't1', name: 'Hall move', description: 'Two halls', task_count: 12, created_by_name: 'Jimmy Henderson',
  updated_at: '2026-11-02T15:00:00Z',
};
const RACK: PlanTemplate = { ...HALL, id: 't2', name: 'Rack swap', description: null, task_count: 1 };
const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: null, scheduled_end: null };

function open(fromTemplate: boolean, templates: PlanTemplate[] = [HALL, RACK]) {
  api.listPlanTemplates.mockResolvedValue(templates);
  const create = vi.fn(async (_body: { project_start: string; template_id?: string }) => {});
  const ctl = { create } as unknown as PlanController;
  const onClose = vi.fn();
  render(<PlanCreateModal ctl={ctl} initiative={INITIATIVE} fromTemplate={fromTemplate} onClose={onClose} />);
  return { create, onClose, user: userEvent.setup() };
}

const picker = () => screen.getByRole('combobox', { name: 'Template' });
async function pick(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await waitFor(() => expect((picker() as HTMLInputElement).disabled).toBe(false));
  await user.click(picker());
  fireEvent.mouseDown(await screen.findByRole('button', { name }));
}

beforeEach(() => {
  toast.mockReset();
  api.listPlanTemplates.mockReset();
});
afterEach(cleanup);

describe('from a template', () => {
  it('is titled for it and offers the templates with their size', async () => {
    const { user } = open(true);
    const dialog = screen.getByRole('dialog', { name: 'New plan from a template' });
    expect(within(dialog).getByText(/every date moved to the project start/)).not.toBeNull();
    await waitFor(() => expect((picker() as HTMLInputElement).disabled).toBe(false));
    await user.click(picker());
    const menu = document.querySelector('.combo-menu') as HTMLElement;
    expect(within(menu).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Hall move12 tasks · Two halls', 'Rack swap1 task']);
    // the project start keeps the first focus (a combobox would open its list)
    expect(screen.getByLabelText('Project start')).toBeTruthy();
  });

  it('requires a template', async () => {
    const { user, create } = open(true);
    await waitFor(() => expect((picker() as HTMLInputElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(screen.getByRole('alert').textContent).toBe('Choose a template.');
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the template with the project start', async () => {
    const { user, create, onClose } = open(true);
    fireEvent.change(screen.getByLabelText('Project start'), { target: { value: '2026-11-09' } });
    await pick(user, /^Rack swap/);
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(create).toHaveBeenCalledWith({ project_start: '2026-11-09', template_id: 't2' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('none saved yet: says how to make one, and Create stays off', async () => {
    open(true, []);
    expect(await screen.findByText(/No templates yet/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Create plan' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a template deleted meanwhile says so and reloads the list', async () => {
    const { user, create } = open(true);
    await pick(user, /^Hall move/);
    create.mockRejectedValueOnce(new ApiError(404, 'template_not_found', { code: 'template_not_found' }));
    api.listPlanTemplates.mockResolvedValue([RACK]);
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(await screen.findByText(PLAN_ERRORS.template_not_found)).not.toBeNull();
    await waitFor(() => expect(api.listPlanTemplates).toHaveBeenCalledTimes(2));
    expect((picker() as HTMLInputElement).value).toBe('');
  });
});

describe('blank plan', () => {
  it('keeps its title; the picker is optional and nothing is sent without a pick', async () => {
    const { user, create } = open(false);
    expect(screen.getByRole('dialog', { name: 'New project plan' })).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Project start'), { target: { value: '2026-11-09' } });
    await waitFor(() => expect((picker() as HTMLInputElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(create).toHaveBeenCalledWith({ project_start: '2026-11-09' });
  });

  it('picking one there makes a plan from it', async () => {
    const { user, create } = open(false);
    fireEvent.change(screen.getByLabelText('Project start'), { target: { value: '2026-11-09' } });
    await pick(user, /^Hall move/);
    expect(screen.getByText(/every date moved to the project start/)).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(create).toHaveBeenCalledWith({ project_start: '2026-11-09', template_id: 't1' });
  });

  it('loads the templates under StrictMode too (dev mounts every effect twice)', async () => {
    api.listPlanTemplates.mockResolvedValue([HALL]);
    render(<StrictMode><PlanCreateModal ctl={{ create: vi.fn() } as unknown as PlanController}
                                        initiative={INITIATIVE} fromTemplate onClose={vi.fn()} /></StrictMode>);
    await waitFor(() => expect((picker() as HTMLInputElement).disabled).toBe(false));
  });

  it('a failed template list never blocks a blank plan', async () => {
    api.listPlanTemplates.mockRejectedValue(new ApiError(500, 'unknown_error', { code: 'unknown_error' }));
    const create = vi.fn(async () => {});
    render(<PlanCreateModal ctl={{ create } as unknown as PlanController} initiative={INITIATIVE}
                            fromTemplate={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Project start'), { target: { value: '2026-11-09' } });
    await waitFor(() => expect(api.listPlanTemplates).toHaveBeenCalled());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create plan' }));
    expect(create).toHaveBeenCalledWith({ project_start: '2026-11-09' });
  });
});
