// @vitest-environment jsdom
/**
 * An initiative's Learning tab: stat tiles, the invites and reminders card
 * (mini timeline, key/values, Edit schedule), what the initiative requires
 * (packets, extras, Assign, Preview rules), the workers roster (filters,
 * search, per-row Resend / Regenerate / Revoke / View history, Resend to
 * selected), Send invites now, the code sheet, the compliance report and the
 * compliance grid. Each mutation control follows its own API action.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type {
  AssignSummary, ComplianceGrid, InitiativeLearning, RosterRow, ScheduleOut,
} from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  learning: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
  other: { reports: true, workers: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => (resource === 'learning'
      ? auth.learning[action] === true
      : auth.other[resource] === true),
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: () => false,
  }),
}));

const api = vi.hoisted(() => ({
  getInitiativeLearning: vi.fn(),
  putInitiativeSchedule: vi.fn(),
  sendInitiativeInvites: vi.fn(),
  listInitiativeRoster: vi.fn(),
  regenerateLearningCode: vi.fn(),
  revokeLearningCodes: vi.fn(),
  downloadCodeSheet: vi.fn(),
  getInitiativeGrid: vi.fn(),
  exportLearningCompliance: vi.fn(),
  dryRunInitiative: vi.fn(),
  assignLearning: vi.fn(),
  listLearningPackets: vi.fn(),
  listLearningDocuments: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: InitiativeLearningTab } = await import('./InitiativeLearningTab');

const SCHEDULE: ScheduleOut = {
  mode: 'scheduled', send_offset_days: 7, send_time: '08:00', reminder_offsets: [5, 3],
  due_offset_days: 2, late_adds: true, sent_at: '2026-11-03T14:00:00Z',
  send_at: '2026-11-03T14:00:00Z', codes_expire_on: '2026-11-21', is_default: false,
};

const SUMMARY: InitiativeLearning = {
  stats: { invited: 42, opened: 38, in_progress: 9, complete: 27, overdue: 4 },
  schedule: SCHEDULE,
  packets: [
    { packet: { id: 'pk1', name: 'Standard onboarding', documents: ['Dress code', 'Confidentiality'] },
      rule_name: 'Everyone', every_initiative: false },
    { packet: { id: 'pk2', name: 'Acme site rules', documents: ['Site rules', 'Acme NDA'] },
      rule_name: 'Client is Acme', every_initiative: true },
  ],
  extras: [{ title: 'Forklift safety', people: 3 }],
  timeline: [
    { date: '2026-11-03', kind: 'invite' }, { date: '2026-11-05', kind: 'reminder' },
    { date: '2026-11-07', kind: 'reminder' }, { date: '2026-11-08', kind: 'due' },
    { date: '2026-11-10', kind: 'start' },
  ],
};

const row = (id: string, name: string, over: Partial<RosterRow> = {}): RosterRow => ({
  person_id: id, name, email: `${id}@mail.test`, partner: 'Encon', language: 'en',
  done: 0, total: 5, status: 'not_opened', last_activity: null, ...over,
});
const ROSTER: RosterRow[] = [
  row('p1', 'Maria Santos', { status: 'complete', done: 5, last_activity: '2026-11-04T10:00:00Z' }),
  row('p2', 'Derek Hill', { status: 'overdue', done: 1, partner: 'Tekno Staff' }),
  row('p3', 'Priya Nair', { status: 'not_opened', language: 'ja' }),
  row('p4', 'Ana Lim', { status: 'no_email', email: null }),
];

const GRID: ComplianceGrid = {
  documents: [{ id: 'd1', title: 'Dress code' }, { id: 'd2', title: 'Acme NDA' }],
  rows: [
    { person_id: 'p1', name: 'Maria Santos', cells: {
      d1: { state: 'valid', label: 'Valid' }, d2: { state: 'expires_during', label: 'Nov 14' } } },
    { person_id: 'p2', name: 'Derek Hill', cells: {
      d1: { state: 'missing', label: 'Missing' }, d2: { state: 'not_required', label: '–' } } },
  ],
};

const DRY: AssignSummary = {
  totals: { checked: 4, to_assign: 6, skipped: 2, no_email: 1 },
  rows: [{ person_id: 'p2', name: 'Derek Hill', will_get: ['Acme NDA'], why: ['Client is Acme'],
    skipped: [], no_email: false }],
};

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/i1?tab=learning']}>
      <Routes>
        <Route path="/initiatives/:id" element={<InitiativeLearningTab initiativeId="i1" />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  auth.learning = { view: true, add: true, change: true, delete: true };
  auth.other = { reports: true, workers: true };
  toast.mockReset();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getInitiativeLearning.mockResolvedValue(SUMMARY);
  api.listInitiativeRoster.mockImplementation(async (_id: string, status?: string) =>
    (status ? ROSTER.filter((r) => r.status === status) : ROSTER));
  api.getInitiativeGrid.mockResolvedValue(GRID);
  api.sendInitiativeInvites.mockResolvedValue(
    { sent: 2, no_email: 1, skipped_complete: 1, already_invited: 0 });
  api.putInitiativeSchedule.mockImplementation(async (_id: string, body: object) => ({ ...SCHEDULE, ...body }));
  api.regenerateLearningCode.mockResolvedValue({ sent: true });
  api.revokeLearningCodes.mockResolvedValue({ revoked: 2 });
  api.downloadCodeSheet.mockResolvedValue(undefined);
  api.exportLearningCompliance.mockResolvedValue({ id: 'run-1' });
  api.dryRunInitiative.mockResolvedValue(DRY);
  api.assignLearning.mockResolvedValue(DRY);
  api.listLearningPackets.mockResolvedValue([
    { id: 'pk3', name: 'Forklift safety', description: null, enforce_order: false,
      due_offset_days: null, icon: null, color: null, item_count: 1, rule_count: 0, archived_at: null }]);
  api.listLearningDocuments.mockResolvedValue([
    { id: 'd1', title: 'Dress code', current_version_no: 2, published_at: '2026-10-01T00:00:00Z',
      packets: [], signoff_count: 0, languages: {}, archived_at: null }]);
});

afterEach(cleanup);

const NAME = { selector: '.lrn-roster-name' };
const rosterName = (name: string) => screen.findByText(name, NAME);

const workerRow = (name: string) =>
  screen.getByText(name, { selector: '.lrn-roster-name' }).closest('.dir-row') as HTMLElement;

async function rowMenu(name: string, item: string) {
  const user = userEvent.setup();
  await user.click(within(workerRow(name)).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

it('renders the stat tiles, the schedule and the requirements', async () => {
  renderTab();
  const tiles = await screen.findByRole('group', { name: 'Learning progress' });
  const tile = (label: string) => within(tiles).getByText(label).closest('.lrn-tile') as HTMLElement;
  expect(within(tile('Invited')).getByText('42')).toBeTruthy();
  expect(within(tile('Opened')).getByText('38')).toBeTruthy();
  expect(within(tile('Opened')).getByText(/90%/)).toBeTruthy();
  expect(within(tile('In progress')).getByText('9')).toBeTruthy();
  expect(within(tile('Complete')).getByText('27')).toBeTruthy();
  expect(within(tile('Overdue')).getByText('4')).toBeTruthy();
  expect(within(tile('Overdue')).getByText(/Due Nov 8/)).toBeTruthy();

  const card = screen.getByRole('region', { name: 'Invites and reminders' });
  expect(within(card).getByText(/7 days before start/)).toBeTruthy();
  expect(within(card).getByText(/8:00 AM/)).toBeTruthy();
  expect(within(card).getByText(/5 and 3 days before start/)).toBeTruthy();
  expect(within(card).getByText(/2 days before start/)).toBeTruthy();
  expect(within(card).getByText(/Nov 21/)).toBeTruthy();
  const events = within(card).getAllByRole('listitem');
  expect(events).toHaveLength(5);
  expect(events[4].textContent).toMatch(/Starts/);

  const needs = screen.getByRole('region', { name: 'What this initiative requires' });
  expect(within(needs).getByText('Standard onboarding')).toBeTruthy();
  expect(within(needs).getByText('Dress code · Confidentiality')).toBeTruthy();
  expect(within(needs).getByText('Every initiative')).toBeTruthy();
  expect(within(needs).getByText(/Forklift safety/)).toBeTruthy();
  expect(within(needs).getByText(/3 people/)).toBeTruthy();
  expect(within(needs).getByText(/Client is Acme/)).toBeTruthy();
});

it('Send invites now confirms with the counts, posts, then shows what happened', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await rosterName('Maria Santos');
  await user.click(screen.getByRole('button', { name: 'Send invites now' }));

  const dialog = await screen.findByRole('dialog', { name: /Send invites/ });
  // 4 on the roster: 1 complete (skipped), 1 without email, 2 to invite
  expect(within(dialog).getByText(/2 people will get an invite/)).toBeTruthy();
  expect(within(dialog).getByText(/1 has no email/)).toBeTruthy();
  expect(within(dialog).getByText(/1 is already complete/)).toBeTruthy();
  expect(api.sendInitiativeInvites).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Send invites' }));
  await waitFor(() => expect(api.sendInitiativeInvites).toHaveBeenCalledWith('i1'));
  const done = await screen.findByRole('status', { name: 'Send result' });
  expect(within(done).getByText('2')).toBeTruthy();   // sent
  expect(within(done).getByText(/No email/)).toBeTruthy();
  expect(within(done).getByText(/Already complete/)).toBeTruthy();
  expect(within(done).getByText(/Already invited/)).toBeTruthy();
  // the tab reloads behind the dialog
  await waitFor(() => expect(api.getInitiativeLearning.mock.calls.length).toBeGreaterThan(1));
});

it('the roster filter refetches with status=', async () => {
  const user = userEvent.setup();
  renderTab();
  await rosterName('Derek Hill');
  expect(api.listInitiativeRoster).toHaveBeenCalledWith('i1', undefined);
  // counts show on the segments
  expect(screen.getByRole('tab', { name: /^Overdue 1$/ })).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: /^Overdue/ }));
  await waitFor(() => expect(api.listInitiativeRoster).toHaveBeenCalledWith('i1', 'overdue'));
  await waitFor(() => expect(screen.queryByText('Maria Santos', NAME)).toBeNull());
  expect(screen.getByText('Derek Hill', NAME)).toBeTruthy();
  expect(screen.getByRole('tab', { name: /^Overdue/ }).getAttribute('aria-selected')).toBe('true');
});

it('searches the roster by name, email or partner', async () => {
  const user = userEvent.setup();
  renderTab();
  await rosterName('Derek Hill');
  await user.type(screen.getByRole('textbox', { name: 'Search workers' }), 'tekno');
  expect(screen.queryByText('Maria Santos', NAME)).toBeNull();
  expect(screen.getByText('Derek Hill', NAME)).toBeTruthy();
});

it('Resend on a row posts person_ids', async () => {
  renderTab();
  await rosterName('Derek Hill');
  await rowMenu('Derek Hill', 'Resend');
  await waitFor(() => expect(api.sendInitiativeInvites).toHaveBeenCalledWith('i1', ['p2']));
  await waitFor(() => expect(toast).toHaveBeenCalled());
});

it('Resend to selected posts every ticked person', async () => {
  const user = userEvent.setup();
  renderTab();
  await rosterName('Derek Hill');
  const bulk = screen.getByRole('button', { name: /Resend to selected/ });
  expect(bulk.hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: 'Select Derek Hill' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair' }));
  expect(screen.getByRole('button', { name: 'Resend to selected (2)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Resend to selected (2)' }));
  await waitFor(() => expect(api.sendInitiativeInvites).toHaveBeenCalledWith('i1', ['p2', 'p3']));
});

it('Regenerate code posts for that person, and a missing email points to the code sheet', async () => {
  renderTab();
  await rosterName('Derek Hill');
  await rowMenu('Derek Hill', 'Regenerate code');
  await waitFor(() => expect(api.regenerateLearningCode).toHaveBeenCalledWith('i1', 'p2'));

  api.regenerateLearningCode.mockRejectedValueOnce(new ApiError(422, 'no_email', {
    code: 'no_email', message: 'This person has no email. Print a code sheet for them instead.' }));
  await rowMenu('Ana Lim', 'Regenerate code');
  await waitFor(() => expect(toast).toHaveBeenLastCalledWith(
    expect.stringMatching(/no email/i)));
});

it('Revoke asks first, then revokes that person’s codes', async () => {
  const user = userEvent.setup();
  renderTab();
  await rosterName('Derek Hill');
  await rowMenu('Derek Hill', 'Revoke');
  const dialog = await screen.findByRole('dialog', { name: /Revoke/ });
  expect(api.revokeLearningCodes).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Revoke codes' }));
  await waitFor(() => expect(api.revokeLearningCodes).toHaveBeenCalledWith('i1', 'p2'));
});

it('View history opens the worker', async () => {
  renderTab();
  await rosterName('Derek Hill');
  await rowMenu('Derek Hill', 'View history');
  expect((await screen.findByTestId('where')).textContent).toBe('/people/workers/p2');
});

it('Edit schedule validates, then PUTs the whole schedule', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Edit schedule' }));
  const dialog = await screen.findByRole('dialog', { name: /Edit schedule/ });

  const days = within(dialog).getByRole('textbox', { name: 'Days before start' });
  const save = within(dialog).getByRole('button', { name: 'Save schedule' });
  await user.clear(days);
  await user.type(days, '0');
  expect(within(dialog).getByText(/at least 1 day/i)).toBeTruthy();
  expect(save.hasAttribute('disabled')).toBe(true);

  await user.clear(days);
  await user.type(days, '10');
  // a reminder day: add 1, drop 3
  await user.click(within(dialog).getByRole('combobox', { name: 'Add a reminder day' }));
  await user.click(await screen.findByRole('button', { name: '1 day before' }));
  await user.click(within(dialog).getByRole('button', { name: 'Remove 3 days before' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Invite people added later' }));
  expect(save.hasAttribute('disabled')).toBe(false);
  await user.click(save);

  await waitFor(() => expect(api.putInitiativeSchedule).toHaveBeenCalledWith('i1', {
    mode: 'scheduled', send_offset_days: 10, send_time: '08:00',
    reminder_offsets: [5, 1], due_offset_days: 2, late_adds: false,
  }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit schedule/ })).toBeNull());
});

it('a manual schedule sends nothing on its own and needs no days', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Edit schedule' }));
  const dialog = await screen.findByRole('dialog', { name: /Edit schedule/ });
  await user.click(within(dialog).getByRole('button', { name: 'Send by hand' }));
  expect(within(dialog).queryByRole('textbox', { name: 'Days before start' })).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
  await waitFor(() => expect(api.putInitiativeSchedule).toHaveBeenCalledWith(
    'i1', expect.objectContaining({ mode: 'manual' })));
});

it('Preview rules runs the dry run for this initiative; applying reloads the tab', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Preview rules' }));
  const dialog = await screen.findByRole('dialog', { name: /Preview rules/ });
  await waitFor(() => expect(api.dryRunInitiative).toHaveBeenCalledWith('i1', false));
  expect(await within(dialog).findByText('Derek Hill')).toBeTruthy();
  // no initiative picker: it's this one
  expect(within(dialog).queryByRole('combobox', { name: 'Initiative to check' })).toBeNull();
  const before = api.getInitiativeLearning.mock.calls.length;
  await user.click(within(dialog).getByRole('button', { name: 'Assign and schedule invites' }));
  await waitFor(() => expect(api.dryRunInitiative).toHaveBeenCalledWith('i1', true));
  await waitFor(() => expect(api.getInitiativeLearning.mock.calls.length).toBeGreaterThan(before));
});

it('Assign hands a packet to the picked people on this initiative', async () => {
  const user = userEvent.setup();
  renderTab();
  await rosterName('Derek Hill');
  await user.click(screen.getByRole('button', { name: 'Assign' }));
  const dialog = await screen.findByRole('dialog', { name: /Assign/ });
  const assign = within(dialog).getByRole('button', { name: 'Assign' });
  expect(assign.hasAttribute('disabled')).toBe(true);

  // people come from the roster
  const people = within(dialog).getByRole('combobox', { name: 'People to assign' });
  await user.click(people);
  await user.click(await screen.findByRole('button', { name: /Derek Hill/ }));

  const packet = within(dialog).getByRole('combobox', { name: 'Packet' });
  await user.click(packet);
  await user.click(await screen.findByRole('button', { name: /Forklift safety/ }));
  expect(assign.hasAttribute('disabled')).toBe(false);
  await user.click(assign);
  await waitFor(() => expect(api.assignLearning).toHaveBeenCalledWith({
    person_ids: ['p2'], initiative_id: 'i1', packet_id: 'pk3', document_ids: [],
  }));
  expect(await within(dialog).findByRole('status')).toBeTruthy();
});

it('Compliance report queues the report for this initiative', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Compliance report' }));
  await waitFor(() => expect(api.exportLearningCompliance).toHaveBeenCalledWith('i1'));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/ready/)));
});

it('Print code sheet downloads the PDF for people without email, or everyone', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Print code sheet' }));
  let dialog = await screen.findByRole('dialog', { name: /code sheet/i });
  expect(within(dialog).getByText(/replaces/i)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
  await waitFor(() => expect(api.downloadCodeSheet).toHaveBeenCalledWith('i1', false));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /code sheet/i })).toBeNull());

  await user.click(screen.getByRole('button', { name: 'Print code sheet' }));
  dialog = await screen.findByRole('dialog', { name: /code sheet/i });
  await user.click(within(dialog).getByRole('button', { name: 'Everyone with open training' }));
  await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
  await waitFor(() => expect(api.downloadCodeSheet).toHaveBeenLastCalledWith('i1', true));
});

it('shows the compliance grid with its legend', async () => {
  renderTab();
  const card = await screen.findByRole('region', { name: 'Compliance grid' });
  await within(card).findByText('Maria Santos');
  expect(within(card).getByText('Dress code')).toBeTruthy();
  expect(within(card).getByText('Acme NDA')).toBeTruthy();
  expect(within(card).getByText('Nov 14')).toBeTruthy();
  const legend = within(card).getByRole('list', { name: 'Legend' });
  ['Valid', 'Expires during the initiative', 'Missing', 'Not required'].forEach((t) =>
    expect(within(legend).getByText(t)).toBeTruthy());
});

it('a view-only manager sees the data but none of the mutation controls', async () => {
  auth.learning = { view: true, add: false, change: false, delete: false };
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await rosterName('Derek Hill');
  expect(screen.queryByRole('button', { name: 'Send invites now' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Print code sheet' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Resend to selected/ })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Select Derek Hill' })).toBeNull();
  // the report needs reports:add, not a learning action; View history still works
  expect(screen.getByRole('button', { name: 'Compliance report' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Preview rules' })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(within(workerRow('Derek Hill')).getByRole('button', { name: /actions/i }));
  expect(screen.queryByRole('menuitem', { name: 'Resend' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'View history' })).toBeTruthy();
});

it('Preview rules without learning:add shows the dry run but not the apply button', async () => {
  auth.learning = { view: true, add: false, change: true, delete: false };
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole('group', { name: 'Learning progress' });
  await user.click(screen.getByRole('button', { name: 'Preview rules' }));
  const dialog = await screen.findByRole('dialog', { name: /Preview rules/ });
  await within(dialog).findByText('Derek Hill');
  expect(within(dialog).queryByRole('button', { name: 'Assign and schedule invites' })).toBeNull();
});

it('says so when the tab can’t load, and tries again', async () => {
  const user = userEvent.setup();
  api.getInitiativeLearning.mockRejectedValueOnce(new ApiError(500, 'boom', {}));
  renderTab();
  expect(await screen.findByRole('alert')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('group', { name: 'Learning progress' })).toBeTruthy();
});
