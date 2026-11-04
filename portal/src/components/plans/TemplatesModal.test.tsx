// @vitest-environment jsdom
/**
 * components/plans/TemplatesModal.tsx (More › Templates…): the saved plan
 * templates, each with its description, task count and who saved it; a
 * row's Actions menu renames it or edits its description in place (one
 * PATCH each) and deletes it only after asking. Who sees which action
 * follows project_plans:change (rename, description) and :delete.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { PlanTemplate } from '../../lib/plans/api';
import { PLAN_ERRORS } from '../../lib/plans/errors';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({
  listPlanTemplates: vi.fn(),
  patchPlanTemplate: vi.fn(),
  deletePlanTemplate: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: TemplatesModal, TEMPLATE_DELETED } = await import('./TemplatesModal');

const HALL: PlanTemplate = {
  id: 't1', name: 'Hall move', description: 'Two halls, one weekend', task_count: 12,
  created_by_name: 'Jimmy Henderson', updated_at: '2026-11-02T15:00:00Z',
};
const RACK: PlanTemplate = {
  id: 't2', name: 'Rack swap', description: null, task_count: 1, created_by_name: null,
  updated_at: '2026-10-30T15:00:00Z',
};

const ALL = { change: true, delete: true };

function open(permissions = ALL, templates: PlanTemplate[] = [HALL, RACK]) {
  api.listPlanTemplates.mockResolvedValue(templates);
  const onClose = vi.fn();
  render(<TemplatesModal permissions={permissions} onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Templates' });
const cards = () => within(screen.getByRole('list', { name: 'Templates' })).getAllByRole('listitem');
const item = (name: string) => cards().find((li) => li.textContent?.includes(name)) as HTMLElement;
/** Hall move's card (sorted first), also while its name is in an editor. */
const hall = () => cards()[0];

async function action(user: ReturnType<typeof userEvent.setup>, template: string, name: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${template}` }));
  await user.click(screen.getByRole('menuitem', { name }));
}

beforeEach(() => {
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
});
afterEach(cleanup);

describe('the list', () => {
  it('is a house plan dialog listing each template with its description, size and author', async () => {
    open();
    expect(dialog().classList.contains('pln-modal')).toBe(true);
    expect(within(dialog()).getByText('Project plan')).not.toBeNull();       // eyebrow
    expect(within(dialog()).getByRole('heading', { level: 3, name: 'Templates' })).not.toBeNull();
    expect(await screen.findByText('Hall move')).not.toBeNull();
    const hall = item('Hall move');
    expect(within(hall).getByText('Two halls, one weekend')).not.toBeNull();
    expect(hall.textContent).toContain('12 tasks');
    expect(hall.textContent).toContain('Saved by Jimmy Henderson');
    const rack = item('Rack swap');
    expect(rack.textContent).toContain('1 task');
    expect(rack.textContent).not.toContain('Saved by');
    expect(within(rack).getByText('No description')).not.toBeNull();
  });

  it('loads under StrictMode too (dev mounts every effect twice)', async () => {
    api.listPlanTemplates.mockResolvedValue([HALL]);
    render(<StrictMode><TemplatesModal permissions={ALL} onClose={vi.fn()} /></StrictMode>);
    expect(await screen.findByText('Hall move')).not.toBeNull();
  });

  it('none yet: says where templates come from', async () => {
    open(ALL, []);
    expect(await screen.findByText(/No templates yet/)).not.toBeNull();
    expect(screen.getByText(/Save as template…/)).not.toBeNull();
  });

  it('a load failure says the templates couldn’t be loaded, beside Try again', async () => {
    api.listPlanTemplates.mockRejectedValueOnce(new ApiError(403, 'forbidden', { code: 'forbidden' }));
    const onClose = vi.fn();
    render(<TemplatesModal permissions={ALL} onClose={onClose} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t load templates.');
    expect(screen.queryByText(PLAN_ERRORS.forbidden)).toBeNull();
    api.listPlanTemplates.mockResolvedValueOnce([HALL]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Hall move')).not.toBeNull();
  });

  it('who sees which action: change renames and describes, delete deletes', async () => {
    open({ change: false, delete: false });
    expect(await screen.findByText('Hall move')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    cleanup();

    const { user } = open({ change: false, delete: true });
    await user.click(await screen.findByRole('button', { name: 'Actions for Hall move' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Delete…']);
    cleanup();

    const editor = open({ change: true, delete: false });
    await editor.user.click(await screen.findByRole('button', { name: 'Actions for Hall move' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename', 'Edit description']);
  });
});

describe('rename', () => {
  it('Rename edits the name in place and posts a PATCH with it', async () => {
    const { user } = open();
    await action(user, 'Hall move', 'Rename');
    const field = within(hall()).getByRole('textbox', { name: 'Template name' }) as HTMLInputElement;
    expect(field.value).toBe('Hall move');
    expect(document.activeElement).toBe(field);
    api.patchPlanTemplate.mockResolvedValueOnce({ ...HALL, name: 'Hall migration' });
    await user.clear(field);
    await user.type(field, '  Hall migration ');
    await user.click(within(hall()).getByRole('button', { name: 'Save' }));
    expect(api.patchPlanTemplate).toHaveBeenCalledWith('t1', { name: 'Hall migration' });
    expect(await screen.findByText('Hall migration')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Template name' })).toBeNull();
  });

  it('Enter saves; Escape cancels without closing the dialog', async () => {
    const { user, onClose } = open();
    await action(user, 'Hall move', 'Rename');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Template name' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.patchPlanTemplate).not.toHaveBeenCalled();

    await action(user, 'Hall move', 'Rename');
    api.patchPlanTemplate.mockResolvedValueOnce({ ...HALL, name: 'Halls' });
    await user.clear(screen.getByRole('textbox', { name: 'Template name' }));
    await user.type(screen.getByRole('textbox', { name: 'Template name' }), 'Halls{Enter}');
    expect(api.patchPlanTemplate).toHaveBeenCalledWith('t1', { name: 'Halls' });
    expect(await screen.findByText('Halls')).not.toBeNull();
  });

  it('an unchanged or blank name sends nothing', async () => {
    const { user } = open();
    await action(user, 'Hall move', 'Rename');
    await user.click(within(hall()).getByRole('button', { name: 'Save' }));
    expect(api.patchPlanTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Template name' })).toBeNull();

    await action(user, 'Hall move', 'Rename');
    await user.clear(screen.getByRole('textbox', { name: 'Template name' }));
    await user.click(within(hall()).getByRole('button', { name: 'Save' }));
    expect(api.patchPlanTemplate).not.toHaveBeenCalled();
    expect(within(hall()).getByRole('alert').textContent).toBe('Enter a name for the template.');
  });

  it('a refused rename keeps the editor and what was typed, with the reason', async () => {
    const { user } = open();
    await action(user, 'Hall move', 'Rename');
    api.patchPlanTemplate.mockRejectedValueOnce(new ApiError(409, 'template_exists', { code: 'template_exists' }));
    const field = screen.getByRole('textbox', { name: 'Template name' }) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, 'Rack swap{Enter}');
    expect(await screen.findByText(PLAN_ERRORS.template_exists)).not.toBeNull();
    expect((screen.getByRole('textbox', { name: 'Template name' }) as HTMLInputElement).value).toBe('Rack swap');
    expect(cards()).toHaveLength(2);
  });
});

describe('description', () => {
  it('Edit description posts a PATCH with the new text; clearing it sends null', async () => {
    const { user } = open();
    await action(user, 'Hall move', 'Edit description');
    const field = within(item('Hall move')).getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    expect(field.value).toBe('Two halls, one weekend');
    api.patchPlanTemplate.mockResolvedValueOnce({ ...HALL, description: 'Three halls' });
    await user.clear(field);
    await user.type(field, 'Three halls');
    await user.click(within(item('Hall move')).getByRole('button', { name: 'Save' }));
    expect(api.patchPlanTemplate).toHaveBeenCalledWith('t1', { description: 'Three halls' });
    expect(await screen.findByText('Three halls')).not.toBeNull();

    await action(user, 'Hall move', 'Edit description');
    api.patchPlanTemplate.mockResolvedValueOnce({ ...HALL, description: null });
    await user.clear(screen.getByRole('textbox', { name: 'Description' }));
    await user.click(within(item('Hall move')).getByRole('button', { name: 'Save' }));
    expect(api.patchPlanTemplate).toHaveBeenLastCalledWith('t1', { description: null });
    await waitFor(() => expect(within(item('Hall move')).getByText('No description')).not.toBeNull());
  });
});

describe('delete', () => {
  it('asks first: Cancel keeps it, Delete template removes it and says so', async () => {
    const { user, onClose } = open();
    await action(user, 'Hall move', 'Delete…');
    const confirm = screen.getByRole('dialog', { name: 'Delete the template “Hall move”?' });
    expect(within(confirm).getByText(/Plans already made from it keep their tasks/)).not.toBeNull();
    expect(api.deletePlanTemplate).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /^Delete the template/ })).toBeNull();
    expect(item('Hall move')).toBeTruthy();
    expect(api.deletePlanTemplate).not.toHaveBeenCalled();

    await action(user, 'Hall move', 'Delete…');
    api.deletePlanTemplate.mockResolvedValueOnce(undefined);
    const again = screen.getByRole('dialog', { name: 'Delete the template “Hall move”?' });
    const button = within(again).getByRole('button', { name: 'Delete template' });
    expect(button.className).toContain('btn-danger');
    await user.click(button);
    expect(api.deletePlanTemplate).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(screen.queryByText('Hall move')).toBeNull());
    expect(toast).toHaveBeenCalledWith(TEMPLATE_DELETED);
    expect(screen.queryByRole('dialog', { name: /^Delete the template/ })).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refused delete stays in the confirm with the reason', async () => {
    const { user } = open();
    await action(user, 'Rack swap', 'Delete…');
    api.deletePlanTemplate.mockRejectedValueOnce(new ApiError(403, 'forbidden', { code: 'forbidden' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete the template “Rack swap”?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete template' }));
    expect(await within(confirm).findByText(PLAN_ERRORS.forbidden)).not.toBeNull();
    expect(item('Rack swap')).toBeTruthy();
  });
});
