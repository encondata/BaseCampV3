// @vitest-environment jsdom
/**
 * /learning — the learning dashboard: tiles from the API, the range switch
 * refetching, Remind sending to the unfinished people with an email, and
 * Export queueing the compliance report for everyone.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LearningDashboard as Dash, RosterRow } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({
  getLearningDashboard: vi.fn(),
  listInitiativeRoster: vi.fn(),
  sendInitiativeInvites: vi.fn(),
  exportLearningCompliance: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: LearningDashboard } = await import('./LearningDashboard');

const DASH: Dash = {
  funnel: { assigned: 186, opened: 171, complete: 139, median_open_hours: 6, median_finish_minutes: 22 },
  overrides: { count: 7, admins: 3 },
  at_risk: [
    { initiative_id: 'i1', name: 'Meridian SIN-2 refresh', starts_in_days: 3, percent: 58, not_finished: 11, no_email: 2 },
    { initiative_id: 'i2', name: 'Acme DFW data center move', starts_in_days: 5, percent: 64, not_finished: 4, no_email: 0 },
  ],
  expiring: [
    { document_id: 'd1', title: 'Confidentiality', people: 23, first_date: '2026-11-01' },
    { document_id: 'd2', title: 'Forklift safety', people: 1, first_date: '2026-11-14' },
  ],
  translation_issues: [{ document_id: 'd3', title: 'Dress code', language: 'he' }],
  hard_questions: [{ question_id: 'q1', document_title: 'Acme NDA', miss_percent: 41 }],
};

const roster = (over: Partial<RosterRow> & { person_id: string }): RosterRow => ({
  name: over.person_id, email: 'x@example.com', partner: null, language: 'en',
  done: 0, total: 2, status: 'not_opened', last_activity: null, ...over,
});

function renderPage() {
  return render(<MemoryRouter><LearningDashboard /></MemoryRouter>);
}

beforeEach(() => {
  api.getLearningDashboard.mockReset().mockResolvedValue(DASH);
  api.listInitiativeRoster.mockReset().mockResolvedValue([]);
  api.sendInitiativeInvites.mockReset().mockResolvedValue(
    { sent: 9, no_email: 2, skipped_complete: 0, already_invited: 0 });
  api.exportLearningCompliance.mockReset().mockResolvedValue({ id: 'run-1' });
  toast.mockReset();
});
afterEach(cleanup);

it('renders the funnel tiles from the API with the 30 day range', async () => {
  renderPage();
  expect(await screen.findByText('186')).toBeTruthy();
  expect(api.getLearningDashboard).toHaveBeenCalledWith(30);
  const tile = (label: string) => screen.getByText(label).closest('.dash-kpi') as HTMLElement;
  expect(within(tile('Opened invite')).getByText('171')).toBeTruthy();
  expect(within(tile('Opened invite')).getByText(/92%.*median 6 h after send/)).toBeTruthy();
  expect(within(tile('Fully signed off')).getByText('139')).toBeTruthy();
  expect(within(tile('Fully signed off')).getByText(/75%.*median 22 min to finish/)).toBeTruthy();
  expect(within(tile('Time clock overrides')).getByText('7')).toBeTruthy();
  expect(within(tile('Time clock overrides')).getByText(/By 3 admins/)).toBeTruthy();
  expect(screen.getByRole('tab', { name: '30 days', selected: true })).toBeTruthy();
});

it('lists initiatives at risk with their ring, timing and counts', async () => {
  renderPage();
  const card = (await screen.findByText('Meridian SIN-2 refresh')).closest('.lrn-risk') as HTMLElement;
  expect(within(card).getByText('58%')).toBeTruthy();
  expect(within(card).getByText('Starts in 3 days · 11 not finished · 2 no email')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Meridian SIN-2 refresh' }).getAttribute('href'))
    .toBe('/initiatives/i1');
  expect(within(card).getByRole('button', { name: 'Remind 9' })).toBeTruthy();
});

it('lists expiring documents, translations and hard questions', async () => {
  renderPage();
  expect(await screen.findByText('Confidentiality')).toBeTruthy();
  expect(screen.getByText('23 workers')).toBeTruthy();
  expect(screen.getByText('1 worker')).toBeTruthy();
  expect(screen.getByText('Hebrew translation, Dress code')).toBeTruthy();
  expect(screen.getByText('Needs review')).toBeTruthy();
  expect(screen.getByText('Acme NDA, a hard question')).toBeTruthy();
  expect(screen.getByText('41% miss it')).toBeTruthy();
});

it('refetches when the range changes', async () => {
  renderPage();
  await screen.findByText('186');
  fireEvent.click(screen.getByRole('tab', { name: '7 days' }));
  await waitFor(() => expect(api.getLearningDashboard).toHaveBeenLastCalledWith(7));
  fireEvent.click(screen.getByRole('tab', { name: 'Quarter' }));
  await waitFor(() => expect(api.getLearningDashboard).toHaveBeenLastCalledWith(90));
  expect(api.getLearningDashboard).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('tab', { name: 'Quarter', selected: true })).toBeTruthy();
});

it('Remind sends to the unfinished people who have an email, then refreshes', async () => {
  api.listInitiativeRoster.mockResolvedValue([
    roster({ person_id: 'a', status: 'overdue' }),
    roster({ person_id: 'b', status: 'in_progress' }),
    roster({ person_id: 'c', status: 'not_opened' }),
    roster({ person_id: 'd', status: 'complete' }),
    roster({ person_id: 'e', status: 'no_email', email: null }),
  ]);
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  await waitFor(() => expect(api.sendInitiativeInvites).toHaveBeenCalledWith('i1', ['a', 'b', 'c']));
  expect(api.listInitiativeRoster).toHaveBeenCalledWith('i1');
  expect(toast).toHaveBeenCalledWith('Reminded 9 people on Meridian SIN-2 refresh');
  await waitFor(() => expect(api.getLearningDashboard).toHaveBeenCalledTimes(2));
});

it('Remind says so when nobody with an email is unfinished', async () => {
  api.listInitiativeRoster.mockResolvedValue([roster({ person_id: 'd', status: 'complete' })]);
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Nobody left to remind on Meridian SIN-2 refresh'));
  expect(api.sendInitiativeInvites).not.toHaveBeenCalled();
});

it('shows the API error when a reminder fails', async () => {
  api.listInitiativeRoster.mockResolvedValue([roster({ person_id: 'a', status: 'overdue' })]);
  api.sendInitiativeInvites.mockRejectedValue(new Error('boom'));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('Export queues the compliance report for everyone', async () => {
  renderPage();
  await screen.findByText('186');
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(api.exportLearningCompliance).toHaveBeenCalledTimes(1));
  expect(toast).toHaveBeenCalledWith("We'll let you know when it's ready");
});

it('offers a retry when the dashboard fails to load', async () => {
  api.getLearningDashboard.mockRejectedValueOnce(new Error('down'));
  renderPage();
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('186')).toBeTruthy();
});

it('shows quiet empty states', async () => {
  api.getLearningDashboard.mockResolvedValue({
    ...DASH, funnel: { assigned: 0, opened: 0, complete: 0, median_open_hours: null, median_finish_minutes: null },
    overrides: { count: 0, admins: 0 }, at_risk: [], expiring: [], translation_issues: [], hard_questions: [],
  });
  renderPage();
  expect(await screen.findByText('No initiatives at risk.')).toBeTruthy();
  expect(screen.getByText('Nothing expiring in the next 30 days.')).toBeTruthy();
  expect(screen.getByText('None in this range')).toBeTruthy();
});
