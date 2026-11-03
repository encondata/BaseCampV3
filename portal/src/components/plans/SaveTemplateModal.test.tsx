// @vitest-environment jsdom
/**
 * components/plans/SaveTemplateModal.tsx (More › Save as template…): a
 * name (required) and a description, posted to save-as-template; a taken
 * name stays in the dialog with the reason.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { PLAN_ERRORS } from '../../lib/plans/errors';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({ saveAsTemplate: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: SaveTemplateModal } = await import('./SaveTemplateModal');

function open() {
  const onClose = vi.fn();
  render(<SaveTemplateModal planId="p1" taskCount={12} onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Save as template' });
const save = () => within(dialog()).getByRole('button', { name: 'Save template' });

beforeEach(() => {
  toast.mockReset();
  api.saveAsTemplate.mockReset();
});
afterEach(cleanup);

describe('Save as template', () => {
  it('a house plan dialog, focus on the name, saying what a template keeps', () => {
    open();
    expect(dialog().classList.contains('pln-modal')).toBe(true);
    expect(within(dialog()).getByText('Project plan')).not.toBeNull();
    expect(within(dialog()).getByRole('heading', { level: 3, name: 'Save as template' })).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    // templates are shared with everyone who can view plans: it says notes go along
    expect(within(dialog()).getByText(
      'Keep this plan’s 12 tasks (durations, links and notes included) and its working week and hours to '
      + 'start new plans from. Resources, progress and the baseline aren’t saved.')).not.toBeNull();
    expect(within(dialog()).getByText(
      'Everyone who can view project plans can see and use templates, task notes included.')).not.toBeNull();
    expect(screen.getByLabelText('Name').closest('.pf-form')).not.toBeNull();
  });

  it('saves the name and description, says so and closes', async () => {
    const { user, onClose } = open();
    api.saveAsTemplate.mockResolvedValueOnce({ id: 't1', name: 'Hall move' });
    await user.type(screen.getByLabelText('Name'), '  Hall move ');
    await user.type(screen.getByLabelText('Description'), 'Two halls');
    await user.click(save());
    expect(api.saveAsTemplate).toHaveBeenCalledWith('p1', { name: 'Hall move', description: 'Two halls' });
    expect(toast).toHaveBeenCalledWith('Template “Hall move” saved.');
    expect(onClose).toHaveBeenCalled();
  });

  it('a blank description is sent as none', async () => {
    const { user } = open();
    api.saveAsTemplate.mockResolvedValueOnce({ id: 't1', name: 'Hall move' });
    await user.type(screen.getByLabelText('Name'), 'Hall move');
    await user.type(screen.getByLabelText('Description'), '   ');
    await user.click(save());
    expect(api.saveAsTemplate).toHaveBeenCalledWith('p1', { name: 'Hall move', description: null });
  });

  it('a name is required', async () => {
    const { user, onClose } = open();
    await user.click(save());
    expect(within(dialog()).getByRole('alert').textContent).toBe('Enter a name for the template.');
    expect(api.saveAsTemplate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a taken name stays open with the reason', async () => {
    const { user, onClose } = open();
    api.saveAsTemplate.mockRejectedValueOnce(new ApiError(409, 'template_exists', { code: 'template_exists' }));
    await user.type(screen.getByLabelText('Name'), 'Hall move{Enter}');
    expect(await within(dialog()).findByText(PLAN_ERRORS.template_exists)).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Hall move');
  });
});
