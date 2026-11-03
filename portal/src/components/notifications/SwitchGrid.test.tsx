// @vitest-environment jsdom
/**
 * SwitchGrid — the category × Inbox / Email grid. Person mode (/me) shows
 * what the person gets, "Company default" or "Your choice", and reports their
 * own values; defaults mode (System › Notifications › Defaults) edits the
 * company defaults themselves. Email needs Inbox in both.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { NotifSwitches, SwitchPair } from '../../lib/api';
import SwitchGrid from './SwitchGrid';

afterEach(cleanup);

const ON: SwitchPair = { inbox: true, email: true };
const DEFAULTS: Record<string, SwitchPair> = {
  approvals: ON, reports: ON, wiki: ON, learning: ON, initiatives: ON, trucks: ON, devices: ON,
};

const LABELS = [
  'Approvals & requests', 'Reports & labels', 'Wiki', 'Learning', 'Initiatives', 'Trucks', 'Devices',
];

type Extra = { defaults?: Record<string, SwitchPair> | null; own?: NotifSwitches;
  emailEnabled?: boolean | null; disabled?: boolean };

/** A person's grid; returns the onChange spy. */
function person(extra: Extra = {}) {
  const onChange = vi.fn();
  render(<SwitchGrid mode="person" defaults={DEFAULTS} emailEnabled onChange={onChange} {...extra} />);
  return onChange;
}

/** The admin's Defaults grid; returns the onChange spy. */
function defaultsGrid(extra: Extra = {}) {
  const onChange = vi.fn();
  render(<SwitchGrid mode="defaults" defaults={DEFAULTS} emailEnabled onChange={onChange} {...extra} />);
  return onChange;
}

const sw = (channel: 'Inbox' | 'Email', category: string) =>
  screen.getByRole('checkbox', { name: `${channel} for ${category}` }) as HTMLInputElement;

/** The reason a switch gives for being off limits: the title of what wraps it. */
const reason = (input: HTMLElement) => input.closest('[title]')?.getAttribute('title') ?? null;

const row = (label: string) => screen.getByRole('row', { name: new RegExp(label) });

it('lists one row per category in registry order, with the design\'s descriptions', () => {
  person();
  const rows = screen.getAllByRole('row').slice(1);   // the first is the header
  expect(rows).toHaveLength(8);
  [...LABELS, 'Account security'].forEach((label, i) => {
    expect(within(rows[i]).getByText(label)).toBeTruthy();
  });
  [
    'Group membership requests and decisions, routers waiting for approval',
    'Reports and label runs, ready or failed',
    'Page updates, comments, mentions, reviews and exports',
    'Learning completed or overdue, quizzes locked',
    'Initiative status changes',
    'Truck status changes',
    'Devices going offline',
    'Password expiring and two-factor notices about your own account',
  ].forEach((text) => expect(screen.getByText(text)).toBeTruthy());
});

it('has Category, Inbox and Email columns', () => {
  person();
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Category', 'Inbox', 'Email']);
});

it('names every switch "{Channel} for {Category}"', () => {
  person();
  const names = screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
  expect(names).toEqual(LABELS.flatMap((l) => [`Inbox for ${l}`, `Email for ${l}`]));
});

// ── person mode ────────────────────────────────────────────────────────

it('person mode: every row follows the company default and says so', () => {
  person();
  expect(screen.getAllByText('Company default')).toHaveLength(7);
  expect(screen.queryByText('Your choice')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use company default' })).toBeNull();
});

it('person mode: the switches show the company default', () => {
  person({ defaults: { ...DEFAULTS, reports: { inbox: true, email: false }, wiki: { inbox: false, email: false } } });
  expect(sw('Inbox', 'Reports & labels').checked).toBe(true);
  expect(sw('Email', 'Reports & labels').checked).toBe(false);
  expect(sw('Inbox', 'Wiki').checked).toBe(false);
  expect(sw('Email', 'Wiki').checked).toBe(false);
  expect(sw('Email', 'Approvals & requests').checked).toBe(true);
});

it('person mode: flipping Reports Email off reports the person\'s own value', async () => {
  const onChange = person();
  await userEvent.click(sw('Email', 'Reports & labels'));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('reports', { email: false });
});

it('person mode: flipping Inbox off reports it, keeping the Email value already set', async () => {
  const onChange = person({ own: { wiki: { email: false } } });
  await userEvent.click(sw('Inbox', 'Wiki'));
  expect(onChange).toHaveBeenCalledWith('wiki', { email: false, inbox: false });
  onChange.mockClear();
  await userEvent.click(sw('Inbox', 'Learning'));
  expect(onChange).toHaveBeenCalledWith('learning', { inbox: false });
});

it('person mode: a switch the person changed says "Your choice" and offers the way back', () => {
  person({ own: { reports: { email: false } } });
  const reports = within(row('Reports & labels'));
  expect(reports.getByText('Your choice')).toBeTruthy();
  expect(reports.getByRole('button', { name: 'Use company default' })).toBeTruthy();
  expect(reports.queryByText('Company default')).toBeNull();
  expect(sw('Email', 'Reports & labels').checked).toBe(false);
  // the other rows still follow the default
  expect(screen.getAllByText('Company default')).toHaveLength(6);
  expect(screen.getAllByRole('button', { name: 'Use company default' })).toHaveLength(1);
});

it('person mode: "Use company default" clears the row', async () => {
  const onChange = person({ own: { reports: { email: false } } });
  await userEvent.click(screen.getByRole('button', { name: 'Use company default' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('reports', undefined);
});

it('person mode: flipping a switch back to the default makes it follow the default again', async () => {
  const onChange = person({ own: { reports: { email: false } } });
  await userEvent.click(sw('Email', 'Reports & labels'));
  expect(onChange).toHaveBeenCalledWith('reports', undefined);
});

it('person mode: a value of their own that equals the default still reads "Your choice"', () => {
  person({
    defaults: { ...DEFAULTS, wiki: { inbox: true, email: false } },
    own: { wiki: { email: false } },
  });
  expect(within(row('Wiki')).getByText('Your choice')).toBeTruthy();
});

it('person mode: Inbox off disables Email, shows it off and says why', () => {
  person({ own: { reports: { inbox: false } } });
  const email = sw('Email', 'Reports & labels');
  expect(email.checked).toBe(false);          // the default's Email is on; with no Inbox it reads off
  expect(email.disabled).toBe(true);
  expect(reason(email)).toBe('Turn on Inbox to get email');
  expect(sw('Inbox', 'Reports & labels').disabled).toBe(false);
  // the other rows' Email switches are untouched
  expect(sw('Email', 'Wiki').disabled).toBe(false);
  expect(reason(sw('Email', 'Wiki'))).toBeNull();
});

it('person mode: an Inbox that is off by default disables Email the same way', () => {
  person({ defaults: { ...DEFAULTS, learning: { inbox: false, email: true } } });
  const email = sw('Email', 'Learning');
  expect(email.checked).toBe(false);
  expect(email.disabled).toBe(true);
  expect(reason(email)).toBe('Turn on Inbox to get email');
});

it('person mode: turning Inbox back on keeps the Email value that was set meanwhile', async () => {
  const onChange = person({ own: { reports: { inbox: false, email: false } } });
  expect(sw('Email', 'Reports & labels').checked).toBe(false);
  await userEvent.click(sw('Inbox', 'Reports & labels'));
  expect(onChange).toHaveBeenCalledWith('reports', { email: false });
});

it('person mode: an Email the person turned on reads on once Inbox is on', () => {
  person({
    defaults: { ...DEFAULTS, reports: { inbox: true, email: false } },
    own: { reports: { email: true } },
  });
  expect(sw('Email', 'Reports & labels').checked).toBe(true);
  expect(sw('Email', 'Reports & labels').disabled).toBe(false);
});

// ── account security ───────────────────────────────────────────────────

it('Account security shows "Always" in both columns and has no switch', () => {
  person();
  const security = within(row('Account security'));
  expect(security.getAllByText('Always')).toHaveLength(2);
  expect(security.queryAllByRole('checkbox')).toHaveLength(0);
  expect(security.queryByText('Company default')).toBeNull();
  expect(screen.getAllByText('Always')).toHaveLength(2);
});

it('Account security shows "Always" in defaults mode too, and in every state of the grid', () => {
  defaultsGrid();
  expect(screen.getAllByText('Always')).toHaveLength(2);
  cleanup();
  person({ defaults: null, emailEnabled: false, disabled: true });
  expect(screen.getAllByText('Always')).toHaveLength(2);
});

// ── defaults mode ──────────────────────────────────────────────────────

it('defaults mode: no state line and no way back, the row is the default itself', () => {
  defaultsGrid({ own: { reports: { email: false } } });   // own values are not this mode's business
  expect(screen.queryByText('Company default')).toBeNull();
  expect(screen.queryByText('Your choice')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use company default' })).toBeNull();
  expect(screen.getAllByRole('checkbox')).toHaveLength(14);
  expect(sw('Email', 'Reports & labels').checked).toBe(true);
});

it('defaults mode: flipping a switch reports the category\'s whole pair', async () => {
  const onChange = defaultsGrid({ defaults: { ...DEFAULTS, reports: { inbox: true, email: false } } });
  await userEvent.click(sw('Email', 'Reports & labels'));
  expect(onChange).toHaveBeenLastCalledWith('reports', { inbox: true, email: true });
  await userEvent.click(sw('Inbox', 'Reports & labels'));
  expect(onChange).toHaveBeenLastCalledWith('reports', { inbox: false, email: false });
  await userEvent.click(sw('Email', 'Wiki'));
  expect(onChange).toHaveBeenLastCalledWith('wiki', { inbox: true, email: false });
  await userEvent.click(sw('Inbox', 'Learning'));
  expect(onChange).toHaveBeenLastCalledWith('learning', { inbox: false, email: true });
});

it('defaults mode: Inbox off disables Email and shows it off, but keeps its value for later', async () => {
  const onChange = defaultsGrid({ defaults: { ...DEFAULTS, wiki: { inbox: false, email: true } } });
  const email = sw('Email', 'Wiki');
  expect(email.checked).toBe(false);
  expect(email.disabled).toBe(true);
  expect(reason(email)).toBe('Turn on Inbox to get email');
  await userEvent.click(sw('Inbox', 'Wiki'));
  expect(onChange).toHaveBeenCalledWith('wiki', { inbox: true, email: true });
});

// ── email not set up, loading, disabled ───────────────────────────────

it('emailEnabled=false disables every Email switch and gives the Phase 0 reason', () => {
  person({ emailEnabled: false });
  LABELS.forEach((label) => {
    const email = sw('Email', label);
    expect(email.disabled).toBe(true);
    expect(reason(email)).toBe("Email isn't set up on this server");
    expect(sw('Inbox', label).disabled).toBe(false);
  });
});

it('emailEnabled=false keeps showing the person\'s own choices, only inert', () => {
  person({ emailEnabled: false, own: { reports: { email: false } } });
  expect(sw('Email', 'Wiki').checked).toBe(true);
  expect(sw('Email', 'Reports & labels').checked).toBe(false);
});

it('emailEnabled=false is also the reason when Inbox is off: Inbox could not help', () => {
  person({ emailEnabled: false, own: { reports: { inbox: false } } });
  expect(reason(sw('Email', 'Reports & labels'))).toBe("Email isn't set up on this server");
});

it('emailEnabled=false applies in defaults mode', () => {
  defaultsGrid({ emailEnabled: false });
  LABELS.forEach((label) => expect(sw('Email', label).disabled).toBe(true));
});

it('emailEnabled=null (not known yet) blocks nothing', () => {
  person({ emailEnabled: null });
  LABELS.forEach((label) => {
    expect(sw('Email', label).disabled).toBe(false);
    expect(reason(sw('Email', label))).toBeNull();
  });
});

it('while the defaults are still loading every switch is disabled and says nothing', () => {
  person({ defaults: null, own: { reports: { email: false } } });
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes).toHaveLength(14);
  expect(boxes.every((b) => b.disabled)).toBe(true);
  expect(boxes.every((b) => !b.checked)).toBe(true);
  expect(boxes.every((b) => reason(b) === null)).toBe(true);
  expect((screen.getByRole('button', { name: 'Use company default' }) as HTMLButtonElement).disabled).toBe(true);
});

it('while the defaults are still loading the defaults grid is inert too', () => {
  defaultsGrid({ defaults: null });
  expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
});

it('a category the defaults do not carry is inert and off, the rest work', () => {
  person({ defaults: { reports: ON } });
  expect(sw('Inbox', 'Wiki').disabled).toBe(true);
  expect(sw('Email', 'Wiki').disabled).toBe(true);
  expect(sw('Inbox', 'Wiki').checked).toBe(false);
  expect(sw('Inbox', 'Reports & labels').disabled).toBe(false);
});

it('disabled makes the whole grid inert, the way back included', async () => {
  const onChange = person({ disabled: true, own: { reports: { email: false } } });
  expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
  const back = screen.getByRole('button', { name: 'Use company default' }) as HTMLButtonElement;
  expect(back.disabled).toBe(true);
  await userEvent.click(back);
  await userEvent.click(sw('Email', 'Wiki'));
  expect(onChange).not.toHaveBeenCalled();
});

it('disabled does not blame Inbox or the server', () => {
  person({ disabled: true });
  LABELS.forEach((label) => expect(reason(sw('Email', label))).toBeNull());
});

// ── controls ───────────────────────────────────────────────────────────

it('uses house controls only: every checkbox is inside a .switch, and there is no select or time input', () => {
  const { container } = render(
    <SwitchGrid mode="person" defaults={DEFAULTS} emailEnabled onChange={() => {}}
                own={{ reports: { email: false }, wiki: { inbox: false } }} />);
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  expect(boxes).toHaveLength(14);
  expect(boxes.every((b) => b.closest('label.switch'))).toBe(true);
  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('input[type="time"]')).toBeNull();
});

it('is a table through DataTable, named for assistive tech', () => {
  person();
  expect(screen.getByRole('table', { name: 'Notification switches' })).toBeTruthy();
});

it('sits in .swgrid, the scope of its themed scrollbar: a card too narrow for it scrolls sideways', () => {
  const { container } = render(
    <SwitchGrid mode="person" defaults={DEFAULTS} emailEnabled onChange={() => {}} />);
  const scroll = container.querySelector('.swgrid > .data-table-scroll');
  expect(scroll).toBeTruthy();
  expect(scroll?.querySelector('table[aria-label="Notification switches"]')).toBeTruthy();
});
