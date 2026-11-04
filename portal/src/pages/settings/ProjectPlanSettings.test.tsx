// @vitest-environment jsdom
/**
 * System settings › Project plans: the defaults every plan inherits (and
 * the calendar a new plan copies). The form shows exactly what GET
 * /system/project-plans returns, checks it with Plan settings' rules,
 * PUTs only the keys that changed (a changed group or calendar whole), and
 * is read-only without settings:change.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { ProjectPlanSettings as Settings } from '../../lib/plans/api';
import { makeSystemSettings } from '../../lib/plans/planFixtures';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({ getProjectPlanSettings: vi.fn(), putProjectPlanSettings: vi.fn() }));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()), ...api,
}));

const { default: ProjectPlanSettings } = await import('./ProjectPlanSettings');

const SETTINGS: Settings = makeSystemSettings();

function renderPage(canChange = true) {
  render(<ProjectPlanSettings canChange={canChange} />);
  return userEvent.setup();
}

const loaded = () => screen.findByRole('heading', { name: 'Scheduling', level: 3 });
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const pressed = (group: string) =>
  within(screen.getByRole('group', { name: group })).getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const saveButton = () => screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.getProjectPlanSettings.mockResolvedValue(structuredClone(SETTINGS));
  api.putProjectPlanSettings.mockImplementation(async (patch: Partial<Settings>) => ({ ...SETTINGS, ...patch }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('System settings › Project plans', () => {
  it('shows exactly what the API returns, in four sections', async () => {
    renderPage();
    await loaded();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Scheduling', 'Default calendar', 'Completion rules', 'Reminders']);
    for (const name of ['Scheduling', 'Default calendar', 'Completion rules', 'Reminders']) {
      expect(section(name).classList.contains('set-section')).toBe(true);
    }

    // Scheduling
    expect(checkbox('Honor constraints').checked).toBe(true);
    expect(input('Critical slack (days)').value).toBe('0');
    expect(pressed('Default task mode')).toEqual(['Auto Scheduled']);
    expect(input('Default duration').value).toBe('1d');
    expect(checkbox('Show times').checked).toBe(false);

    // Default calendar, with its one-line hint
    const hint = within(section('Default calendar'))
      .getByText('New plans start with this calendar; existing plans keep their own.');
    expect(hint.classList.contains('page-hint')).toBe(true);
    expect(input('Monday hours 1 start').value).toBe('08:00');
    expect(input('Monday hours 2 end').value).toBe('17:00');
    expect(checkbox('Saturday working').checked).toBe(false);
    expect(input('Exception 1 name').value).toBe('Thanksgiving');

    // Completion rules
    expect(pressed('Completing a summary task')).toEqual(['Complete them too']);
    expect(pressed('Open predecessors')).toEqual(['Must be complete first']);

    // Reminders
    const reminders = section('Reminders');
    expect((within(reminders).getByRole('checkbox', { name: 'Reminders' }) as HTMLInputElement).checked).toBe(true);
    expect(within(reminders).getByText('3 days before')).toBeTruthy();
    expect(within(reminders).getByText('1 day before')).toBeTruthy();
    expect(checkbox('On the due day').checked).toBe(true);
    expect(pressed('Overdue reminders')).toEqual(['Daily']);
    expect(input('Send time').value).toBe('08:00');
    expect(checkbox('Use Finish when there’s no Deadline').checked).toBe(false);
    expect(checkbox('Notify on assignment').checked).toBe(true);
    expect(checkbox('Tell the owner about overdue tasks').checked).toBe(true);
    expect(checkbox('Email assignees').checked).toBe(true);
  });

  it('Use Finish when there’s no Deadline says summary tasks need their own Deadline', async () => {
    renderPage();
    await loaded();
    expect(screen.getByText(
      'A task with no Deadline is due at its Finish. Summary tasks are reminded only when they have their own Deadline.',
    ).id).toBe('pps-use_finish_without_deadline-hint');
  });

  it('the send time is a native time field inside a .pf-form (house rule)', async () => {
    renderPage();
    await loaded();
    const time = input('Send time');
    expect(time.type).toBe('time');
    expect(time.closest('.pf-form')).not.toBeNull();
  });

  it('starts clean: nothing to save or discard', async () => {
    renderPage();
    await loaded();
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('offsets changed to 7, 2: Save sends the whole reminders group, then a toast', async () => {
    const user = renderPage();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Remove 3 days before' }));
    await user.click(screen.getByRole('button', { name: 'Remove 1 day before' }));
    expect(screen.getByText('Pick 1 to 5 days.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    const box = screen.getByRole('combobox', { name: 'Add a reminder day' });
    await user.type(box, '7{Enter}');
    await user.type(box, '2{Enter}');
    expect(within(section('Reminders')).getByText('7 days before')).toBeTruthy();
    expect(within(section('Reminders')).getByText('2 days before')).toBeTruthy();

    await user.click(saveButton());
    await waitFor(() => expect(api.putProjectPlanSettings).toHaveBeenCalledTimes(1));
    expect(api.putProjectPlanSettings).toHaveBeenCalledWith({
      reminders: { ...SETTINGS.reminders, offsets_days: [7, 2] },
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Project plan settings saved'));
    // the saved settings are the new baseline
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('at five days the picker offers no more', async () => {
    api.getProjectPlanSettings.mockResolvedValue({
      ...structuredClone(SETTINGS), reminders: { ...SETTINGS.reminders, offsets_days: [14, 7, 3, 2, 1] },
    });
    const user = renderPage();
    await loaded();
    await user.click(screen.getByRole('combobox', { name: 'Add a reminder day' }));
    expect(screen.queryByRole('button', { name: '5 days before' })).toBeNull();
    expect(screen.getByText('5 days is the most.')).toBeTruthy();
  });

  it('an invalid duration "abc" disables Save with an inline error; Discard puts it back', async () => {
    const user = renderPage();
    await loaded();
    await user.clear(input('Default duration'));
    await user.type(input('Default duration'), 'abc');
    expect(input('Default duration').getAttribute('aria-invalid')).toBe('true');
    expect(within(section('Scheduling')).getByRole('alert').textContent).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input('Default duration').value).toBe('1d');
    expect(within(section('Scheduling')).queryByRole('alert')).toBeNull();
    expect(api.putProjectPlanSettings).not.toHaveBeenCalled();
  });

  it('a change that can’t be saved says what to fix next to Save, and “Go to it” brings that field up', async () => {
    const user = renderPage();
    await loaded();
    expect(document.querySelector('.pln-sys-fix')).toBeNull();
    await user.clear(input('Default duration'));
    await user.type(input('Default duration'), 'abc');
    const actions = document.querySelector('.pln-sys-actions') as HTMLElement;
    const note = within(actions).getByText('Fix “Default duration” above.');
    expect(note.closest('.page-hint')).not.toBeNull();
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    await user.click(within(actions).getByRole('button', { name: 'Go to it' }));
    expect(document.activeElement).toBe(input('Default duration'));
    expect(scrolled.mock.contexts[0]).toBe(input('Default duration'));
    // fixed: the note goes
    await user.clear(input('Default duration'));
    await user.type(input('Default duration'), '2d');
    expect(document.querySelector('.pln-sys-fix')).toBeNull();
  });

  it('“Go to it” reaches a calendar field and the reminder days too', async () => {
    const user = renderPage();
    await loaded();
    await user.clear(input('Hours per day'));
    await user.type(input('Hours per day'), '25');
    const actions = document.querySelector('.pln-sys-actions') as HTMLElement;
    expect(within(actions).getByText('Fix “Hours per day” above.')).toBeTruthy();
    expect(input('Hours per day').getAttribute('aria-invalid')).toBe('true');
    await user.click(within(actions).getByRole('button', { name: 'Go to it' }));
    expect(document.activeElement).toBe(input('Hours per day'));

    await user.clear(input('Hours per day'));
    await user.type(input('Hours per day'), '8');
    await user.click(screen.getByRole('button', { name: 'Remove 3 days before' }));
    await user.click(screen.getByRole('button', { name: 'Remove 1 day before' }));
    expect(within(actions).getByText('Fix “Days before due” above.')).toBeTruthy();
    await user.click(within(actions).getByRole('button', { name: 'Go to it' }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add a reminder day' }));
  });

  it('critical slack takes a fraction of a day', async () => {
    const user = renderPage();
    await loaded();
    await user.clear(input('Critical slack (days)'));
    await user.type(input('Critical slack (days)'), '0.5');
    await user.click(saveButton());
    await waitFor(() => expect(api.putProjectPlanSettings).toHaveBeenCalledWith({ critical_slack_days: 0.5 }));
  });

  it('switches, the task mode and a completion rule go as their keys and group', async () => {
    const user = renderPage();
    await loaded();
    await user.click(checkbox('Show times'));
    await user.click(within(screen.getByRole('group', { name: 'Default task mode' }))
      .getByRole('button', { name: 'Manually Scheduled' }));
    await user.click(within(screen.getByRole('group', { name: 'Open predecessors' }))
      .getByRole('button', { name: 'Warn' }));
    await user.click(saveButton());
    await waitFor(() => expect(api.putProjectPlanSettings).toHaveBeenCalledWith({
      show_times: true, default_task_mode: 'manual', completion: { subtasks: 'cascade', predecessors: 'warn' },
    }));
  });

  it('a calendar change sends the whole calendar', async () => {
    const user = renderPage();
    await loaded();
    await user.click(checkbox('Saturday working'));
    await user.click(saveButton());
    await waitFor(() => expect(api.putProjectPlanSettings).toHaveBeenCalledTimes(1));
    expect(api.putProjectPlanSettings.mock.calls[0][0]).toEqual({
      calendar: {
        ...SETTINGS.calendar,
        week: { ...SETTINGS.calendar.week, sat: [['08:00', '12:00'], ['13:00', '17:00']] },
      },
    });
  });

  it('a send time typed into the time field goes in the reminders group', async () => {
    const user = renderPage();
    await loaded();
    fireEvent.change(input('Send time'), { target: { value: '07:30' } });
    await user.click(saveButton());
    await waitFor(() => expect(api.putProjectPlanSettings).toHaveBeenCalledWith({
      reminders: { ...SETTINGS.reminders, send_time: '07:30' },
    }));
  });

  it('a refusal stays on the page with its reason, and nothing is reset', async () => {
    api.putProjectPlanSettings.mockRejectedValueOnce(
      new ApiError(422, 'bad_field', { code: 'bad_field', field: 'default_duration' }));
    const user = renderPage();
    await loaded();
    await user.clear(input('Default duration'));
    await user.type(input('Default duration'), '2d');
    await user.click(saveButton());
    expect(await screen.findByText('Check the “Default duration” setting.')).toBeTruthy();
    expect(input('Default duration').value).toBe('2d');
    expect(toast).not.toHaveBeenCalled();
  });

  it('read-only without settings:change: every control off, no Save', async () => {
    renderPage(false);
    await loaded();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(checkbox('Honor constraints').disabled).toBe(true);
    expect(input('Default duration').disabled).toBe(true);
    expect(input('Critical slack (days)').disabled).toBe(true);
    expect(input('Send time').disabled).toBe(true);
    expect(checkbox('Saturday working').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add exception' }) as HTMLButtonElement).disabled).toBe(true);
    for (const b of within(screen.getByRole('group', { name: 'Overdue reminders' })).getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('button', { name: 'Remove 3 days before' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed load says so and tries again', async () => {
    api.getProjectPlanSettings.mockRejectedValueOnce(new ApiError(500, 'server_error'));
    const user = renderPage();
    expect(await screen.findByText('Couldn’t load the project plan settings.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(api.getProjectPlanSettings).toHaveBeenCalledTimes(2);
  });
});
