// @vitest-environment jsdom
/**
 * The worker page's Learning history panel: sign-offs, quiz attempts, open
 * assignments and time clock overrides from GET /learning/people/{id}/history.
 * The Certificate button is for learning managers only; a workers:view
 * reader sees initiative names only when the API sends them.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningHistory } from '../../lib/learning';

const auth = vi.hoisted(() => ({ manager: true }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string) => (auth.manager ? resource === 'learning' : resource === 'workers'),
    scope: { global: true },
  }),
}));

const api = vi.hoisted(() => ({ getLearningHistory: vi.fn(), downloadCertificate: vi.fn() }));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()), ...api,
}));

const { default: LearningHistoryPanel } = await import('./LearningHistoryPanel');

const HISTORY: LearningHistory = {
  person: { id: 'p1', name: 'Wes Worker' },
  signoffs: [
    { id: 's1', document_id: 'd1', document: 'Confidentiality', version: 3, language: 'ja',
      signed_at: '2026-10-20T15:30:00Z', read_seconds: 75, quiz_score: 90,
      initiative_id: 'i1', initiative: 'NAP11 Move' },
    { id: 's2', document_id: 'd2', document: 'Forklift safety', version: 1, language: 'en',
      signed_at: '2026-09-02T15:30:00Z', read_seconds: 40, quiz_score: null,
      initiative_id: null, initiative: null },
  ],
  quiz_attempts: [
    { id: 'q1', document_id: 'd1', document: 'Confidentiality', score_percent: 50, passed: false,
      created_at: '2026-10-20T15:00:00Z', initiative_id: 'i1', initiative: 'NAP11 Move' },
    { id: 'q2', document_id: 'd1', document: 'Confidentiality', score_percent: 90, passed: true,
      created_at: '2026-10-20T15:20:00Z', initiative_id: 'i1', initiative: 'NAP11 Move' },
  ],
  overrides: [
    { id: 'o1', created_at: '2026-10-21T12:00:00Z', reason: 'signed_on_paper', reason_text: null,
      scope: 'day', local_day: '2026-10-21', admin: 'Alice Admin', initiative_id: 'i1',
      initiative: 'NAP11 Move' },
  ],
  open_assignments: [
    { id: 'a1', document_id: 'd3', document: 'Dress code', status: 'opened', source: 'rule',
      due_on: '2026-11-03', initiative_id: 'i1', initiative: 'NAP11 Move' },
  ],
};

beforeEach(() => {
  auth.manager = true;
  api.getLearningHistory.mockResolvedValue(HISTORY);
  api.downloadCertificate.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const table = (name: string) => screen.getByRole('table', { name });

it('lists the sign-offs with version, language, read time and quiz score', async () => {
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  expect(api.getLearningHistory).toHaveBeenCalledWith('p1');
  await screen.findByText('Confidentiality');
  const row = screen.getByText('Confidentiality').closest('tr') as HTMLElement;
  expect(within(row).getByText('v3')).toBeTruthy();
  expect(within(row).getByText('Japanese')).toBeTruthy();
  expect(within(row).getByText('1 min 15 s')).toBeTruthy();
  expect(within(row).getByText('90%')).toBeTruthy();
  expect(within(row).getByText('NAP11 Move')).toBeTruthy();
  const general = screen.getByText('Forklift safety').closest('tr') as HTMLElement;
  expect(within(general).getByText('General')).toBeTruthy();
  expect(screen.getByText('2 sign-offs')).toBeTruthy();
});

it('switches to quiz attempts, open assignments and overrides', async () => {
  const user = userEvent.setup();
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  await screen.findByText('Confidentiality');

  await user.click(screen.getByRole('tab', { name: /Quiz attempts/ }));
  const attempts = within(table('Quiz attempts'));
  expect(attempts.getByText('Passed')).toBeTruthy();
  expect(attempts.getByText('Failed')).toBeTruthy();
  expect(attempts.getByText('50%')).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: /Open/ }));
  const open = within(table('Open assignments'));
  expect(open.getByText('Dress code')).toBeTruthy();
  expect(open.getByText('Opened')).toBeTruthy();
  expect(open.getByText('Assignment rule')).toBeTruthy();
  expect(open.getByText('Nov 3, 2026')).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: /Time clock overrides/ }));
  const overrides = within(table('Time clock overrides'));
  expect(overrides.getByText('Alice Admin')).toBeTruthy();
  expect(overrides.getByText('Signed on paper')).toBeTruthy();
  expect(overrides.getByText('Rest of the day')).toBeTruthy();
});

it('shows a neutral name when the reader cannot see initiatives', async () => {
  api.getLearningHistory.mockResolvedValue({
    ...HISTORY,
    signoffs: [{ ...HISTORY.signoffs[0], initiative: null }],
  });
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  await screen.findByText('Confidentiality');
  expect(screen.getByText('An initiative')).toBeTruthy();
  expect(screen.queryByText('NAP11 Move')).toBeNull();
});

it('offers the certificate to learning managers and downloads it', async () => {
  const user = userEvent.setup();
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  await screen.findByText('Confidentiality');
  await user.click(screen.getByRole('button', { name: 'Certificate' }));
  expect(api.downloadCertificate).toHaveBeenCalledWith('p1', 'Wes Worker');
});

it('hides the certificate from a workers:view reader', async () => {
  auth.manager = false;
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  await screen.findByText('Confidentiality');
  expect(screen.queryByRole('button', { name: 'Certificate' })).toBeNull();
});

it('says so when the certificate fails', async () => {
  api.downloadCertificate.mockRejectedValue(new ApiError(500, 'boom'));
  const user = userEvent.setup();
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  await screen.findByText('Confidentiality');
  await user.click(screen.getByRole('button', { name: 'Certificate' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('shows an empty note when there is no learning activity', async () => {
  api.getLearningHistory.mockResolvedValue({
    person: HISTORY.person, signoffs: [], quiz_attempts: [], overrides: [], open_assignments: [],
  });
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  expect(await screen.findByText('No learning activity yet.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Certificate' })).toBeNull();
});

it('offers Try again when the history will not load', async () => {
  api.getLearningHistory.mockRejectedValueOnce(new Error('x')).mockResolvedValue(HISTORY);
  const user = userEvent.setup();
  render(<LearningHistoryPanel personId="p1" personName="Wes Worker" />);
  expect(await screen.findByText(/Couldn.t load the learning history/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.getByText('Forklift safety')).toBeTruthy());
});
