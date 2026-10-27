// @vitest-environment jsdom
/**
 * /learning — the learning dashboard: tiles from the API, the range switch
 * refetching, Remind (learning:change only) confirming and then sending the
 * reminder email (never a Resend), and Export queueing the compliance
 * report for everyone.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LearningDashboard as Dash } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const allowed = vi.hoisted(() => ({ actions: new Set(['view', 'change']) }));
vi.mock('../../components/learning/useLearningAccess', () => ({
  useLearningAccess: () => (action: string) => allowed.actions.has(action),
}));

const api = vi.hoisted(() => ({
  getLearningDashboard: vi.fn(),
  remindInitiative: vi.fn(),
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

function renderPage() {
  return render(<MemoryRouter><LearningDashboard /></MemoryRouter>);
}

beforeEach(() => {
  api.getLearningDashboard.mockReset().mockResolvedValue(DASH);
  api.remindInitiative.mockReset().mockResolvedValue(
    { sent: 8, no_email: 2, no_code: 1, skipped_complete: 0 });
  api.sendInitiativeInvites.mockReset();
  allowed.actions = new Set(['view', 'change']);
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

it('Remind confirms first, then sends the reminder (no new codes) and refreshes', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  const dialog = await screen.findByRole('dialog', { name: 'Send reminders' });
  expect(within(dialog).getByText('9 people on Meridian SIN-2 refresh have training to finish.')).toBeTruthy();
  expect(within(dialog).getByText(/codes keep working and nobody is signed out/)).toBeTruthy();
  expect(api.remindInitiative).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send reminders' }));
  await waitFor(() => expect(api.remindInitiative).toHaveBeenCalledWith('i1'));
  expect(api.sendInitiativeInvites).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    'Reminded 8 people · 2 without email · 1 without a working code on Meridian SIN-2 refresh');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(api.getLearningDashboard).toHaveBeenCalledTimes(2));
});

it('Cancel in the Remind dialog sends nothing', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  const dialog = await screen.findByRole('dialog', { name: 'Send reminders' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.remindInitiative).not.toHaveBeenCalled();
});

it('shows the API error in the dialog when a reminder fails', async () => {
  api.remindInitiative.mockRejectedValue(new Error('boom'));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Remind 9' }));
  const dialog = await screen.findByRole('dialog', { name: 'Send reminders' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send reminders' }));
  expect(await within(dialog).findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Send reminders' })).toBeTruthy();
});

it('a view-only manager gets Open instead of Remind', async () => {
  allowed.actions = new Set(['view']);
  renderPage();
  const card = (await screen.findByText('Meridian SIN-2 refresh')).closest('.lrn-risk') as HTMLElement;
  expect(within(card).queryByRole('button', { name: /Remind/ })).toBeNull();
  expect(within(card).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/initiatives/i1');
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
