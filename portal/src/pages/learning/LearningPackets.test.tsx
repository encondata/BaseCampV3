// @vitest-environment jsdom
/**
 * /learning/packets — the packet list (documents, rules using it, order,
 * due) and the editor it opens: New packet (learning:add) and a row click.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { PacketListItem } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  perms: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'learning' && auth.perms[action] === true,
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: () => false,
  }),
}));

const api = vi.hoisted(() => ({ listLearningPackets: vi.fn() }));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));
vi.mock('../../components/learning/PacketEditor', () => ({
  default: ({ packetId, onSaved, onChanged, onClose }: {
    packetId: string | null; onSaved: () => void; onChanged: (m: string) => void; onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Packet editor">
      <span>editing {packetId ?? 'new'}</span>
      <button type="button" onClick={onSaved}>mock save</button>
      <button type="button" onClick={() => onChanged('Archived X')}>mock archive</button>
      <button type="button" onClick={onClose}>mock close</button>
    </div>
  ),
}));

const { default: LearningPackets } = await import('./LearningPackets');

const PACKETS: PacketListItem[] = [
  {
    id: 'p1', name: 'Standard onboarding', description: 'For everyone', enforce_order: true,
    due_offset_days: null, icon: null, color: null, item_count: 3, rule_count: 1, archived_at: null,
  },
  {
    id: 'p2', name: 'Acme site rules', description: null, enforce_order: false,
    due_offset_days: 5, icon: null, color: null, item_count: 1, rule_count: 0, archived_at: null,
  },
];

const renderPage = () => render(<MemoryRouter><LearningPackets /></MemoryRouter>);

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.listLearningPackets.mockReset().mockResolvedValue(PACKETS);
  toast.mockReset();
});
afterEach(cleanup);

it('lists packets with documents, rules, order and due', async () => {
  renderPage();
  const std = (await screen.findByText('Standard onboarding')).closest('.dir-row') as HTMLElement;
  expect(within(std).getByText('3 documents')).toBeTruthy();
  expect(within(std).getByText('1 rule')).toBeTruthy();
  expect(within(std).getByText('In order')).toBeTruthy();
  expect(within(std).getByText('Initiative schedule')).toBeTruthy();
  const acme = screen.getByText('Acme site rules').closest('.dir-row') as HTMLElement;
  expect(within(acme).getByText('1 document')).toBeTruthy();
  expect(within(acme).getByText('0 rules')).toBeTruthy();
  expect(within(acme).getByText('Any order')).toBeTruthy();
  expect(within(acme).getByText('5 days before start')).toBeTruthy();
});

it('a row opens the editor for that packet; saving reloads the list', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByText('Acme site rules'));
  expect(await screen.findByText('editing p2')).toBeTruthy();
  api.listLearningPackets.mockClear();
  await user.click(screen.getByRole('button', { name: 'mock save' }));
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('New packet opens an empty editor; a change from the editor toasts and reloads', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Standard onboarding');
  await user.click(screen.getByRole('button', { name: 'New packet' }));
  expect(await screen.findByText('editing new')).toBeTruthy();
  api.listLearningPackets.mockClear();
  await user.click(screen.getByRole('button', { name: 'mock archive' }));
  expect(toast).toHaveBeenCalledWith('Archived X');
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
});

it('without learning:add there is no New packet button', async () => {
  auth.perms = { view: true };
  renderPage();
  await screen.findByText('Standard onboarding');
  expect(screen.queryByRole('button', { name: 'New packet' })).toBeNull();
});

it('shows an empty state and a load failure with retry', async () => {
  api.listLearningPackets.mockResolvedValueOnce([]);
  const first = renderPage();
  expect(await screen.findByText(/no packets yet/i)).toBeTruthy();
  first.unmount();
  api.listLearningPackets.mockRejectedValueOnce(new ApiError(500, 'boom'));
  renderPage();
  expect(await screen.findByText(/couldn.t load the packets/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Standard onboarding')).toBeTruthy();
});
