// @vitest-environment jsdom
/** The worker page's "Give portal login" header button. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { WorkerDetailItem } from '../lib/workers';

const auth = vi.hoisted(() => ({
  perms: new Set<string>(['workers:view', 'workers:change', 'users:add']),
  global: true,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (res: string, action = 'view') => auth.perms.has(`${res}:${action}`),
    scope: { global: auth.global, client_ids: [], partner_ids: [] },
    maxRank: 60, passwordMinLength: 8,
  }),
}));

const workers = vi.hoisted(() => ({ getWorker: vi.fn() }));
vi.mock('../lib/workers', async (importActual) => ({
  ...(await importActual<typeof import('../lib/workers')>()), ...workers,
}));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(async () => new Response('[]', { status: 200 })),
  listWorkerStatuses: vi.fn(async () => []),
  listTimeEntries: vi.fn(async () => []),
  adminCreateAccountRequest: vi.fn(async () => {}),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

// heavy children with their own fetching — not under test here
vi.mock('../components/AvatarUpload', () => ({ default: () => null }));
vi.mock('../components/workers/CertsPanel', () => ({ default: () => null }));
vi.mock('../components/NotesFilesPanel', () => ({ default: () => null }));
vi.mock('../components/learning/LearningHistoryPanel', () => ({
  default: ({ personId, personName }: { personId: string; personName: string }) => (
    <div data-testid="learning-history">{personId}:{personName}</div>
  ),
}));

const badge = vi.hoisted(() => ({ printBadgeQr: vi.fn() }));
vi.mock('../components/people/BadgeQr', () => badge);

const { default: WorkerDetail } = await import('./WorkerDetail');

const WORKER: WorkerDetailItem = {
  person_id: 'w1', display_name: 'Wes Worker', first_name: 'Wes', last_name: 'Worker',
  contact_email: 'wes@x.test', phone: null, avatar_url: null, has_account: false,
  trade: null, level: null, status: 'active', status_label: 'Active', status_color: '#178a4c',
  status_note: null, partner: null, cert_count: 0, certs_expired: 0,
  preferred_name: null, job_title: null, address_line1: null, address_line2: null, city: null,
  region: null, postal_code: null, country: 'US', badge_uid: 'B1', rfid_tag: null,
  person_notes: null, source: 'manual', source_ref: null, created_at: '2026-01-01T00:00:00Z',
  level_def: null, initiatives: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.perms = new Set(['workers:view', 'workers:change', 'users:add']);
  auth.global = true;
  workers.getWorker.mockResolvedValue(WORKER);
});
afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/people/workers/w1']}>
      <Routes><Route path="/people/workers/:personId" element={<WorkerDetail />} /></Routes>
    </MemoryRouter>,
  );
}

it('shows Give portal login with no account, users:add and global access', async () => {
  renderPage();
  expect(await screen.findByRole('button', { name: 'Give portal login' })).toBeTruthy();
});

it('hides it when the worker already has an account', async () => {
  workers.getWorker.mockResolvedValue({ ...WORKER, has_account: true });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: /Wes Worker/ });
  expect(screen.queryByRole('button', { name: 'Give portal login' })).toBeNull();
});

it('hides it without users:add', async () => {
  auth.perms = new Set(['workers:view', 'workers:change']);
  renderPage();
  await screen.findByRole('heading', { level: 1, name: /Wes Worker/ });
  expect(screen.queryByRole('button', { name: 'Give portal login' })).toBeNull();
});

it('hides it without global access', async () => {
  auth.global = false;
  renderPage();
  await screen.findByRole('heading', { level: 1, name: /Wes Worker/ });
  expect(screen.queryByRole('button', { name: 'Give portal login' })).toBeNull();
});

it('opens the shared grant dialog and reloads the worker on success', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Give portal login' }));
  expect(screen.getByRole('dialog', { name: 'Grant portal access' })).toBeTruthy();
  expect((screen.getByLabelText('Login email *') as HTMLInputElement).value).toBe('wes@x.test');
  workers.getWorker.mockResolvedValue({ ...WORKER, has_account: true });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(api.adminCreateAccountRequest).toHaveBeenCalledWith(
    'w1', expect.objectContaining({ login_email: 'wes@x.test', must_change_password: true })));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Grant portal access' })).toBeNull());
  expect(workers.getWorker).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Give portal login' })).toBeNull());
  expect(screen.getByText('portal access')).toBeTruthy();
});

it('shows Print QR with a badge uid and prints the name and uid', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Print QR' }));
  expect(badge.printBadgeQr).toHaveBeenCalledWith({ name: 'Wes Worker', badgeUid: 'B1' });
});

it('hides Print QR when the API withholds the badge uid', async () => {
  workers.getWorker.mockResolvedValue({ ...WORKER, badge_uid: null });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: /Wes Worker/ });
  expect(screen.queryByRole('button', { name: 'Print QR' })).toBeNull();
});

it('shows the Learning history panel for the worker', async () => {
  renderPage();
  expect((await screen.findByTestId('learning-history')).textContent).toBe('w1:Wes Worker');
});
