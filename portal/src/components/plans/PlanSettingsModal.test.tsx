// @vitest-environment jsdom
/**
 * components/plans/PlanSettingsModal.tsx (with CalendarEditor): Plan
 * settings in four `.segmented` sections. Save sends only what changed
 * (settingsForm.toPatch) through ctl.patch; nothing changed closes; a
 * check that fails shows by its field on its section and sends nothing;
 * the owner picker lists staff only; "Use system default (<value>)" names
 * the system value and turning it back on sends null; a locked plan edits
 * only the status date and the owner.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { Plan } from '../../lib/plans/api';
import { planView } from '../../lib/plans/merge';
import { makePlan } from '../../lib/plans/planFixtures';
import PlanSettingsModal from './PlanSettingsModal';
import type { PlanController } from './usePlan';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

afterEach(cleanup);
beforeEach(() => toast.mockReset());

function plan(over: Partial<Plan> = {}): Plan {
  const base = makePlan();
  return makePlan({
    owner_id: 'p1', owner_name: 'Dana Reyes',
    // the plan overrides the system's Warn with Must be complete first
    settings_overrides: { completion: { predecessors: 'block' } },
    settings: { ...base.settings, completion: { ...base.settings.completion, predecessors: 'block' } },
    resources: [
      { kind: 'person', id: 'p1', name: 'Dana Reyes', group: 'team', has_email: true, has_account: true, is_staff: true },
      { kind: 'person', id: 'p2', name: 'Lee Park', group: 'team', has_email: true, has_account: false, is_staff: false },
      { kind: 'person', id: 'p3', name: 'Ari Moss', group: 'staff', has_email: true, has_account: true, is_staff: true },
      { kind: 'partner', id: 'x1', name: 'Acme Freight', group: 'partner', has_email: false, has_account: false, is_staff: false },
    ],
    ...over,
  });
}

function open(p: Plan, patch = vi.fn(async (_fields: unknown) => {})) {
  const view = planView(p);
  const release = vi.fn();
  const ctl = {
    status: 'ready', plan: view.plan, outline: view.outline, patch, beginEditing: vi.fn(() => release),
  } as unknown as PlanController;
  const onClose = vi.fn();
  render(<PlanSettingsModal ctl={ctl} onClose={onClose} />);
  return { patch, onClose, ctl, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Plan settings' });
const section = (name: string) => within(dialog()).getByRole('button', { name });
const save = () => within(dialog()).getByRole('button', { name: 'Save' });

describe('Plan settings', () => {
  it('four sections in a segmented control, sized xwide, holding editing', () => {
    const { ctl } = open(plan());
    expect(dialog().classList.contains('pln-modal-xwide')).toBe(true);
    const tabs = within(dialog()).getByRole('group', { name: 'Plan settings sections' });
    expect(tabs.classList.contains('segmented')).toBe(true);
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['General', 'Calendar', 'Completion rules', 'Reminders']);
    expect(ctl.beginEditing).toHaveBeenCalledWith('plan-settings');
  });

  it('nothing changed: Save closes without a write', async () => {
    const { patch, onClose, user } = open(plan());
    await user.click(save());
    expect(patch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('the owner picker lists staff only; the timezone picker every zone', async () => {
    const { patch, user } = open(plan());
    await user.click(within(dialog()).getByRole('combobox', { name: 'Owner' }));
    const menu = document.querySelector('.combo-menu') as HTMLElement;
    const names = within(menu).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Ari Moss', 'Dana Reyes']);
    fireEvent.mouseDown(within(menu).getByRole('button', { name: 'Ari Moss' }));
    await user.click(within(dialog()).getByRole('combobox', { name: 'Timezone' }));
    await user.type(within(dialog()).getByRole('combobox', { name: 'Timezone' }), 'Denver');
    fireEvent.mouseDown(await screen.findByRole('button', { name: /^America\/Denver/ }));
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ owner_id: 'p3', timezone: 'America/Denver' }));
  });

  it('critical slack in days, fractions allowed', async () => {
    const { patch, user } = open(plan());
    const slack = screen.getByLabelText('Critical slack (days)');
    await user.clear(slack);
    await user.type(slack, '1.5');
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ settings: { critical_slack_days: 1.5 } }));
  });

  it('Completion rules: "Use system default (<value>)" names it; turning it back on sends null', async () => {
    const { patch, user } = open(plan());
    await user.click(section('Completion rules'));
    const inherit = within(dialog()).getByRole('checkbox', { name: 'Open predecessors: use system default (Warn)' });
    expect((inherit as HTMLInputElement).checked).toBe(false);
    expect(within(dialog()).getByText('Use system default (Warn)')).toBeTruthy();
    await user.click(inherit);
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ settings: { completion: { predecessors: null } } }));
  });

  it('Reminders: turning a default off shows its control; the value goes as an override', async () => {
    const { patch, user } = open(plan());
    await user.click(section('Reminders'));
    expect(within(dialog()).queryByLabelText('Send time')).toBeNull();
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Send time: use system default (8:00 AM)' }));
    fireEvent.change(within(dialog()).getByLabelText('Send time'), { target: { value: '07:30' } });
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ settings: { reminders: { send_time: '07:30' } } }));
  });

  it('Reminders: the native time field sits inside a .pf-form (house rule for native date and time inputs)', async () => {
    const { user } = open(plan());
    await user.click(section('Reminders'));
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Send time: use system default (8:00 AM)' }));
    const time = within(dialog()).getByLabelText('Send time') as HTMLInputElement;
    expect(time.type).toBe('time');
    expect(time.closest('.pf-form')).not.toBeNull();
    // the section keeps its look: the items still stack as cards
    expect(time.closest('.pf-form')?.classList.contains('pln-set-items')).toBe(true);
  });

  it('Calendar: an exception added goes in the whole calendar', async () => {
    const { patch, user } = open(plan());
    await user.click(section('Calendar'));
    await user.click(within(dialog()).getByRole('button', { name: 'Add exception' }));
    fireEvent.change(within(dialog()).getByLabelText('Exception 1 date'), { target: { value: '2026-11-26' } });
    await user.type(within(dialog()).getByLabelText('Exception 1 name'), 'Thanksgiving');
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const sent = patch.mock.calls[0][0] as { calendar: Plan['calendar'] };
    expect(Object.keys(sent)).toEqual(['calendar']);
    expect(sent.calendar.exceptions).toEqual([{ date: '2026-11-26', name: 'Thanksgiving', hours: [] }]);
  });

  it('Calendar: no working day is refused on its section, and nothing is sent', async () => {
    const { patch, user } = open(plan());
    await user.click(section('Calendar'));
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      await user.click(within(dialog()).getByRole('checkbox', { name: `${day} working` }));
    }
    await user.click(section('General'));
    await user.click(save());
    expect(patch).not.toHaveBeenCalled();
    expect(section('Calendar').getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog()).getByText('At least one working day is needed')).toBeTruthy();
  });

  it('Calendar: the HH:MM fields keep the text keyboard (iOS’s number pad has no colon)', async () => {
    const { user } = open(plan());
    await user.click(section('Calendar'));
    const times = [...document.querySelectorAll<HTMLInputElement>('.pln-cal-time')];
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t.inputMode).toBe('text');
  });

  it('Calendar: 24:00 ends a day; hours per day over 24 are refused', async () => {
    const { patch, user } = open(plan());
    await user.click(section('Calendar'));
    const end = within(dialog()).getByLabelText('Monday hours 2 end');
    await user.clear(end);
    await user.type(end, '24:00');
    const perDay = within(dialog()).getByLabelText('Hours per day');
    await user.clear(perDay);
    await user.type(perDay, '25');
    await user.click(save());
    expect(patch).not.toHaveBeenCalled();
    expect(within(dialog()).getByText('Hours per day: more than 0, at most 24.')).toBeTruthy();
    await user.clear(perDay);
    await user.type(perDay, '8');
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect((patch.mock.calls[0][0] as { calendar: Plan['calendar'] }).calendar.week.mon)
      .toEqual([['08:00', '12:00'], ['13:00', '24:00']]);
  });

  it('a refusal stays in the dialog; someone else’s change closes it quietly', async () => {
    const patch = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'bad_timezone', { code: 'bad_timezone' }))
      .mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed' }));
    const { onClose, user } = open(plan(), patch);
    const slack = screen.getByLabelText('Critical slack (days)');
    await user.clear(slack);
    await user.type(slack, '2');
    await user.click(save());
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(within(dialog()).getByRole('alert').textContent).toBe('Choose a timezone from the list.');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('a locked plan', () => {
  it('edits only the status date and the owner; the rest shows, off, saying why', async () => {
    const { patch, user } = open(plan({ locked_at: '2026-10-27T12:00:00Z' }));
    expect(within(dialog()).getAllByText(/Schedule is locked/).length).toBeGreaterThan(0);
    expect((screen.getByLabelText('Project start') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Critical slack (days)') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog()).getByRole('combobox', { name: 'Timezone' }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog()).getByRole('combobox', { name: 'Owner' }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Status date'), { target: { value: '2026-11-05' } });
    await user.click(section('Calendar'));
    expect((within(dialog()).getByLabelText('Hours per day') as HTMLInputElement).disabled).toBe(true);
    await user.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ status_date: '2026-11-05' }));
  });
});
