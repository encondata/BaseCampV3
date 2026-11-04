// @vitest-environment jsdom
/** ProfileForm — the Trade box is a chips input; the PUT carries the trades as
 *  one comma-separated string, or null when there are none. */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { WorkerItem } from '../../lib/workers';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: ProfileForm } = await import('./ProfileForm');

const WORKER: WorkerItem = {
  person_id: 'w1', display_name: 'Wes Worker', first_name: 'Wes', last_name: 'Worker',
  contact_email: null, phone: null, avatar_url: null, has_account: false,
  trade: 'Cable, Hardware', level: null, status: 'active', status_label: 'Active',
  status_color: '#178a4c', status_note: null, partner: null, cert_count: 0, certs_expired: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response);
});
afterEach(cleanup);

function renderForm(worker: WorkerItem = WORKER, tradeSuggestions?: string[]) {
  const onDone = vi.fn();
  render(
    <ProfileForm worker={worker} levels={[]} statuses={[{ key: 'active', label: 'Active' } as never]}
                 tradeSuggestions={tradeSuggestions} onDone={onDone} onCancel={() => {}} />,
  );
  return { onDone };
}

const tradeBox = () => within(document.querySelector('.tag-input-box') as HTMLElement);
const tradeInput = () => document.querySelector('.tag-input-field') as HTMLInputElement;

async function savedTrade(): Promise<unknown> {
  await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
  const [path, init] = api.apiFetch.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/workers/w1/profile');
  expect(init.method).toBe('PUT');
  return JSON.parse(init.body as string).trade;
}

it('seeds the Trade box with one chip per trade', () => {
  renderForm();
  expect(screen.getByText('Trade / specialty')).toBeTruthy();
  expect(tradeBox().getByText('Cable')).toBeTruthy();
  expect(tradeBox().getByText('Hardware')).toBeTruthy();
  expect(document.querySelectorAll('.tag-input-box .tag-chip')).toHaveLength(2);
});

it('removing a chip and saving sends the remaining trades', async () => {
  renderForm();
  fireEvent.click(tradeBox().getByRole('button', { name: 'Remove Cable' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBe('Hardware');
});

it('removing every chip and saving sends null', async () => {
  renderForm();
  fireEvent.click(tradeBox().getByRole('button', { name: 'Remove Cable' }));
  fireEvent.click(tradeBox().getByRole('button', { name: 'Remove Hardware' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBeNull();
});

it('a trade typed but not committed with Enter is still saved when Save is clicked', async () => {
  const user = userEvent.setup();
  renderForm();
  await user.type(tradeInput(), 'Fiber');
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBe('Cable, Hardware, Fiber');
});

it('a tag holding a comma saves as separate, trimmed trades', async () => {
  renderForm({ ...WORKER, trade: null });
  fireEvent.change(tradeInput(), { target: { value: 'Cable, Fiber' } });
  fireEvent.blur(tradeInput());
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBe('Cable, Fiber');
});

it('keeps every trade of a long existing list', () => {
  const trade = Array.from({ length: 15 }, (_, i) => `T${i + 1}`).join(', ');
  renderForm({ ...WORKER, trade });
  expect(document.querySelectorAll('.tag-input-box .tag-chip')).toHaveLength(15);
});

it('offers the suggestions it is given', () => {
  renderForm({ ...WORKER, trade: null }, ['Cable', 'Fiber']);
  fireEvent.focus(tradeInput());
  fireEvent.change(tradeInput(), { target: { value: 'Fi' } });
  expect(screen.getByRole('button', { name: 'Fiber' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Cable' })).toBeNull();
});

it('saves a typed trade in the suggestion spelling when it matches case-insensitively', async () => {
  renderForm({ ...WORKER, trade: null }, ['Cable', 'Fiber']);
  fireEvent.change(tradeInput(), { target: { value: 'cable' } });
  fireEvent.blur(tradeInput());
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBe('Cable');
});

it('canonical spelling still dedupes case-insensitively', async () => {
  renderForm({ ...WORKER, trade: 'cable, CABLE, Other' }, ['Cable']);
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(await savedTrade()).toBe('Cable, Other');
});
