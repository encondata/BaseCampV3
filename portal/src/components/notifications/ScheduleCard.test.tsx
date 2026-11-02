// @vitest-environment jsdom
/**
 * ScheduleCard — "When email reaches you": timezone, the days the person
 * works, quiet hours, and the line that says when a summary goes out. It only
 * ever hands its parent a schedule the API would accept: at least one day,
 * and quiet hours either off or a start and an end that differ.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NotifSchedule } from '../../lib/api';
import { DAYS } from '../../lib/notifications';
import ScheduleCard from './ScheduleCard';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});
afterEach(cleanup);

const WORKWEEK = ['mon', 'tue', 'wed', 'thu', 'fri'] as NotifSchedule['days'];
const NEVER_WAIT = 'Critical notifications never wait.';

const value = (over: Partial<NotifSchedule> = {}): NotifSchedule => ({
  timezone: 'America/Chicago', days: [...DAYS], quiet_start: null, quiet_end: null, ...over,
});

/** The parent the way /me is: what it is told to save becomes the value. */
function Saved({ initial, onChange }: { initial: NotifSchedule; onChange: (n: NotifSchedule) => void }) {
  const [saved, setSaved] = useState(initial);
  return <ScheduleCard value={saved} onChange={(n) => { onChange(n); setSaved(n); }} />;
}

function setup(initial: NotifSchedule = value()) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const view = render(<Saved initial={initial} onChange={onChange} />);
  return { onChange, user, ...view };
}

const dayButton = (d: string) => screen.getByRole('button', { name: d });
const pressedDays = () => DAYS.filter((d) => {
  const label = d[0].toUpperCase() + d.slice(1);
  return dayButton(label).getAttribute('aria-pressed') === 'true';
});
const quietSwitch = () => screen.getByRole('checkbox', { name: 'Quiet hours' }) as HTMLInputElement;
const startBox = () => screen.getByRole('combobox', { name: 'Quiet hours start' }) as HTMLInputElement;
const endBox = () => screen.getByRole('combobox', { name: 'Quiet hours end' }) as HTMLInputElement;
const zoneBox = () => screen.getByRole('combobox', { name: 'Timezone' }) as HTMLInputElement;
const summary = () => screen.getByRole('status').textContent;

async function pickTime(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, option: string) {
  await user.click(box);
  await user.click(await screen.findByRole('button', { name: option }));
}

// ── the card ───────────────────────────────────────────────────────────

it('is the "When email reaches you" card, with the design\'s copy', () => {
  setup();
  expect(screen.getByRole('heading', { name: 'When email reaches you' })).toBeTruthy();
  expect(screen.getByText(
    'Email that arrives during quiet hours or on a day off waits, then comes as one summary '
    + 'an hour before your day starts. Your inbox in the portal still updates right away.')).toBeTruthy();
});

it('uses house controls only: one Switch, ComboBoxes and day pills — no select, time input or bare checkbox', () => {
  const { container } = setup();
  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('input[type="time"]')).toBeNull();
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  expect(boxes).toHaveLength(1);
  expect(boxes[0].closest('label.switch')).toBeTruthy();
  const pills = container.querySelector('.day-pills');
  expect(pills?.getAttribute('role')).toBe('group');
  expect(pills?.getAttribute('aria-label')).toBe('Days you work');
  expect(pills?.querySelectorAll('button.mini-btn')).toHaveLength(7);
});

it('does not clip the pickers\' lists: they open outside the card', async () => {
  const { user, container } = setup();
  await user.click(startBox());   // quiet hours are off, so the box is inert
  expect(screen.queryByRole('button', { name: '9:00 PM' })).toBeNull();
  await user.click(quietSwitch());
  await user.click(startBox());
  const option = await screen.findByRole('button', { name: '9:00 PM' });
  expect(container.contains(option)).toBe(false);
});

// ── timezone ───────────────────────────────────────────────────────────

it('timezone: shows the stored zone', () => {
  setup(value({ timezone: 'America/Denver' }));
  expect(zoneBox().value).toBe('America/Denver');
});

it('timezone: an unset zone shows the company reference zone and keeps it unset', async () => {
  const { user, onChange } = setup(value({ timezone: null }));
  expect(zoneBox().value).toBe('America/New_York');
  await user.click(dayButton('Sun'));
  expect(onChange).toHaveBeenLastCalledWith(value({ timezone: null, days: DAYS.filter((d) => d !== 'sun') }));
});

it('timezone: a stored zone that no longer loads still shows, so it can be replaced', async () => {
  const { user, onChange } = setup(value({ timezone: 'Zone/Unknown' }));
  expect(zoneBox().value).toBe('Zone/Unknown');
  await user.click(zoneBox());
  await user.type(zoneBox(), 'Denver');
  await user.click(await screen.findByRole('button', { name: /^America\/Denver/ }));
  expect(onChange).toHaveBeenCalledWith(value({ timezone: 'America/Denver' }));
});

it('timezone: picking a zone saves it with the rest unchanged', async () => {
  const { user, onChange } = setup(value({ days: WORKWEEK, quiet_start: '21:00', quiet_end: '06:00' }));
  await user.click(zoneBox());
  await user.type(zoneBox(), 'Denver');
  await user.click(await screen.findByRole('button', { name: /^America\/Denver/ }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(
    value({ timezone: 'America/Denver', days: WORKWEEK, quiet_start: '21:00', quiet_end: '06:00' }));
  expect(zoneBox().value).toBe('America/Denver');
});

it('timezone: picking the zone it already has saves nothing', async () => {
  const { user, onChange } = setup();
  await user.click(zoneBox());
  await user.type(zoneBox(), 'Chicago');
  await user.click(await screen.findByRole('button', { name: /^America\/Chicago/ }));
  expect(onChange).not.toHaveBeenCalled();
});

// ── days you work ──────────────────────────────────────────────────────

it('days: shows which days are on', () => {
  setup(value({ days: WORKWEEK }));
  expect(pressedDays()).toEqual(WORKWEEK);
  expect(dayButton('Sat').className).not.toContain('active');
  expect(dayButton('Mon').className).toContain('active');
});

it('days: toggling Sat on saves the days in week order', async () => {
  const { user, onChange } = setup(value({ days: WORKWEEK }));
  await user.click(dayButton('Sat'));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(value({ days: [...WORKWEEK, 'sat'] }));
  expect(pressedDays()).toEqual([...WORKWEEK, 'sat']);
});

it('days: a day added back goes where it belongs, not at the end', async () => {
  const { user, onChange } = setup(value({ days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }));
  await user.click(dayButton('Mon'));
  expect(onChange).toHaveBeenCalledWith(value());   // mon first, all seven
  await user.click(dayButton('Wed'));
  await user.click(dayButton('Wed'));
  expect(onChange).toHaveBeenLastCalledWith(value());
});

it('days: toggling a day off saves the rest', async () => {
  const { user, onChange } = setup();
  await user.click(dayButton('Sun'));
  expect(onChange).toHaveBeenCalledWith(value({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }));
});

it('days: removing every day keeps the last saved schedule, shows the warning and saves nothing more', async () => {
  const { user, onChange } = setup(value({ days: ['sat', 'sun'] }));
  await user.click(dayButton('Sat'));
  expect(onChange).toHaveBeenCalledTimes(1);           // [sun] is still a schedule
  await user.click(dayButton('Sun'));
  expect(onChange).toHaveBeenCalledTimes(1);           // none is not
  expect(pressedDays()).toEqual([]);
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('Pick at least one day.');
  expect(status.className).toContain('warn');
});

it('days: with nothing picked and nothing saved, the warning shows and onChange is never called', async () => {
  const { user, onChange } = setup(value({ days: ['sat'] }));
  await user.click(dayButton('Sat'));
  expect(onChange).not.toHaveBeenCalled();
  expect(summary()).toBe('Pick at least one day.');
});

it('days: picking a day again clears the warning and saves', async () => {
  const { user, onChange } = setup(value({ days: ['sat'] }));
  await user.click(dayButton('Sat'));
  await user.click(dayButton('Mon'));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(value({ days: ['mon'] }));
  expect(summary()).not.toBe('Pick at least one day.');
  expect(screen.getByRole('status').className).not.toContain('warn');
});

it('days: picking the one day that was saved again saves nothing', async () => {
  const { user, onChange } = setup(value({ days: ['sat'] }));
  await user.click(dayButton('Sat'));
  await user.click(dayButton('Sat'));
  expect(onChange).not.toHaveBeenCalled();
  expect(summary()).not.toBe('Pick at least one day.');
});

// ── quiet hours ────────────────────────────────────────────────────────

it('quiet hours: off to begin with, the pickers inert and empty', () => {
  setup();
  expect(quietSwitch().checked).toBe(false);
  expect(startBox().disabled).toBe(true);
  expect(endBox().disabled).toBe(true);
  expect(startBox().value).toBe('');
  expect(endBox().value).toBe('');
});

it('quiet hours: turning them on shows two empty pickers, proposes no times and saves nothing', async () => {
  const { user, onChange, container } = setup();
  await user.click(quietSwitch());
  expect(quietSwitch().checked).toBe(true);
  expect(startBox().disabled).toBe(false);
  expect(endBox().disabled).toBe(false);
  expect(startBox().value).toBe('');
  expect(endBox().value).toBe('');
  expect(onChange).not.toHaveBeenCalled();
  expect(container.querySelector('select')).toBeNull();
  expect(screen.getAllByRole('combobox')).toHaveLength(3);   // timezone, start, end
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('Pick a start and end time.');
  expect(status.className).toContain('warn');
});

it('quiet hours: nothing saves until both times are picked', async () => {
  const { user, onChange } = setup();
  await user.click(quietSwitch());
  await pickTime(user, startBox(), '9:00 PM');
  expect(startBox().value).toBe('9:00 PM');
  expect(onChange).not.toHaveBeenCalled();
  expect(summary()).toBe('Pick a start and end time.');

  await pickTime(user, endBox(), '6:00 AM');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  expect(summary()).toBe(
    'Email that waits arrives as one summary at 5:00 AM CT, an hour before quiet hours end on a day you work. '
    + NEVER_WAIT);
});

it('quiet hours: picking the end first works the same', async () => {
  const { user, onChange } = setup();
  await user.click(quietSwitch());
  await pickTime(user, endBox(), '6:00 AM');
  expect(onChange).not.toHaveBeenCalled();
  await pickTime(user, startBox(), '10:30 PM');
  expect(onChange).toHaveBeenCalledWith(value({ quiet_start: '22:30', quiet_end: '06:00' }));
});

it('quiet hours: a start equal to the end is not saved', async () => {
  const { user, onChange } = setup();
  await user.click(quietSwitch());
  await pickTime(user, startBox(), '9:00 PM');
  await pickTime(user, endBox(), '9:00 PM');
  expect(onChange).not.toHaveBeenCalled();
  expect(summary()).toBe('Pick a start and end time.');
  await pickTime(user, endBox(), '7:00 AM');
  expect(onChange).toHaveBeenCalledWith(value({ quiet_start: '21:00', quiet_end: '07:00' }));
});

it('quiet hours: an overnight window and a same-day window both save', async () => {
  const { user, onChange } = setup(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  await pickTime(user, startBox(), '1:00 AM');   // 1 AM to 6 AM: same day
  expect(onChange).toHaveBeenLastCalledWith(value({ quiet_start: '01:00', quiet_end: '06:00' }));
  await pickTime(user, startBox(), '7:00 AM');   // 7 AM to 6 AM: wraps past midnight
  expect(onChange).toHaveBeenLastCalledWith(value({ quiet_start: '07:00', quiet_end: '06:00' }));
});

it('quiet hours: a window that is already saved shows on, with its times', () => {
  setup(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  expect(quietSwitch().checked).toBe(true);
  expect(startBox().disabled).toBe(false);
  expect(startBox().value).toBe('9:00 PM');
  expect(endBox().value).toBe('6:00 AM');
});

it('quiet hours: a stored time off the quarter hour shows as itself', () => {
  setup(value({ quiet_start: '21:10', quiet_end: '06:00' }));
  expect(startBox().value).toBe('9:10 PM');
});

it('quiet hours: turning them off saves both times as cleared', async () => {
  const { user, onChange } = setup(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  await user.click(quietSwitch());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(value({ quiet_start: null, quiet_end: null }));
  expect(startBox().disabled).toBe(true);
  expect(endBox().disabled).toBe(true);
  expect(startBox().value).toBe('');
  expect(endBox().value).toBe('');
});

it('quiet hours: turning them on again after off proposes no times', async () => {
  const { user } = setup(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  await user.click(quietSwitch());
  await user.click(quietSwitch());
  expect(quietSwitch().checked).toBe(true);
  expect(startBox().value).toBe('');
  expect(endBox().value).toBe('');
  expect(summary()).toBe('Pick a start and end time.');
});

it('quiet hours: a time picked and then switched off is cleared too, and not proposed again', async () => {
  const { user, onChange } = setup();
  await user.click(quietSwitch());
  await pickTime(user, startBox(), '9:00 PM');
  await user.click(quietSwitch());
  expect(startBox().value).toBe('');
  expect(startBox().disabled).toBe(true);
  await user.click(quietSwitch());
  expect(startBox().value).toBe('');
  expect(endBox().value).toBe('');
  expect(onChange).not.toHaveBeenCalled();
});

it('quiet hours: switching on and straight off again saves nothing', async () => {
  const { user, onChange } = setup();
  await user.click(quietSwitch());
  await user.click(quietSwitch());
  expect(onChange).not.toHaveBeenCalled();
  expect(summary()).toBe('No quiet hours and no days off, so email always goes out right away.');
});

it('quiet hours: picking the time that is already saved saves nothing', async () => {
  const { user, onChange } = setup(value({ quiet_start: '21:00', quiet_end: '06:00' }));
  await pickTime(user, startBox(), '9:00 PM');
  expect(onChange).not.toHaveBeenCalled();
});

it('a change made while quiet hours are half set is saved with them once they are complete', async () => {
  const { user, onChange } = setup(value({ days: WORKWEEK }));
  await user.click(quietSwitch());
  await user.click(dayButton('Sat'));
  expect(onChange).not.toHaveBeenCalled();             // not a schedule yet
  expect(pressedDays()).toEqual([...WORKWEEK, 'sat']);
  await pickTime(user, startBox(), '9:00 PM');
  await pickTime(user, endBox(), '6:00 AM');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(
    value({ days: [...WORKWEEK, 'sat'], quiet_start: '21:00', quiet_end: '06:00' }));
});

it('a change made while quiet hours are half set is saved when they are switched off', async () => {
  const { user, onChange } = setup(value({ days: WORKWEEK }));
  await user.click(quietSwitch());
  await user.click(dayButton('Sat'));
  await user.click(quietSwitch());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(value({ days: [...WORKWEEK, 'sat'] }));
});

// ── the summary line ───────────────────────────────────────────────────

it('summary: starts from what is saved', () => {
  setup(value({ days: WORKWEEK }));
  expect(summary()).toBe(
    'Email from days off arrives as one summary at 11:00 PM CT the night before the next day you work. '
    + NEVER_WAIT);
  expect(screen.getByRole('status').className).not.toContain('warn');
});

it('summary: says email goes out right away with every day on and no quiet hours', () => {
  setup();
  expect(summary()).toBe('No quiet hours and no days off, so email always goes out right away.');
});

it('summary: updates as the schedule changes', async () => {
  const { user } = setup();
  await user.click(dayButton('Sat'));
  await user.click(dayButton('Sun'));
  expect(summary()).toBe(
    'Email from days off arrives as one summary at 11:00 PM CT the night before the next day you work. '
    + NEVER_WAIT);

  await user.click(quietSwitch());
  await pickTime(user, startBox(), '1:00 AM');
  await pickTime(user, endBox(), '6:00 AM');
  expect(summary()).toBe(
    'Email that waits during quiet hours arrives as one summary at 5:00 AM CT. '
    + 'Email from days off arrives as one summary at 11:00 PM CT the night before the next day you work. '
    + NEVER_WAIT);

  await pickTime(user, startBox(), '9:00 PM');   // now it covers midnight
  expect(summary()).toBe(
    'Email that waits arrives as one summary at 5:00 AM CT, an hour before quiet hours end on a day you work. '
    + NEVER_WAIT);
});

it('summary: follows the timezone picked', async () => {
  const { user } = setup(value({ days: WORKWEEK }));
  await user.click(zoneBox());
  await user.type(zoneBox(), 'Denver');
  await user.click(await screen.findByRole('button', { name: /^America\/Denver/ }));
  expect(summary()).toContain('11:00 PM MT');
});

it('summary: reads the card\'s own draft even when the parent keeps the old value', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<ScheduleCard value={value()} onChange={onChange} />);   // never updates `value`
  await user.click(dayButton('Sat'));
  expect(onChange).toHaveBeenCalledWith(value({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sun'] }));
  expect(pressedDays()).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sun']);
  expect(summary()).toContain('11:00 PM CT');
});

// ── following the saved schedule ───────────────────────────────────────

it('shows a new saved schedule when the parent hands one in', () => {
  const onChange = vi.fn();
  const { rerender } = render(<ScheduleCard value={value()} onChange={onChange} />);
  rerender(<ScheduleCard value={value({
    timezone: 'America/Denver', days: WORKWEEK, quiet_start: '22:00', quiet_end: '07:00',
  })} onChange={onChange} />);
  expect(zoneBox().value).toBe('America/Denver');
  expect(pressedDays()).toEqual(WORKWEEK);
  expect(quietSwitch().checked).toBe(true);
  expect(startBox().value).toBe('10:00 PM');
  expect(endBox().value).toBe('7:00 AM');
});

it('a parent that hands in an equal copy of the same schedule does not undo a draft', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<ScheduleCard value={value({ days: ['sat'] })} onChange={onChange} />);
  await user.click(dayButton('Sat'));
  expect(summary()).toBe('Pick at least one day.');
  rerender(<ScheduleCard value={value({ days: ['sat'] })} onChange={onChange} />);   // a new object, same schedule
  expect(summary()).toBe('Pick at least one day.');
  expect(pressedDays()).toEqual([]);
});

it('names its controls for assistive tech', () => {
  setup();
  const card = screen.getByRole('heading', { name: 'When email reaches you' }).closest('section') as HTMLElement;
  expect(within(card).getByRole('combobox', { name: 'Timezone' })).toBeTruthy();
  expect(within(card).getByRole('group', { name: 'Days you work' })).toBeTruthy();
  expect(within(card).getByRole('checkbox', { name: 'Quiet hours' })).toBeTruthy();
});
