// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const listAudit = vi.hoisted(() => vi.fn());
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  listAudit,
  getAuditFacets: vi.fn().mockResolvedValue({ entity_types: ['user', 'role'], actions: [] }),
}));

import Audit from './Audit';

afterEach(() => { cleanup(); listAudit.mockReset(); });

const row = (id: number, action: string) =>
  ({ id, at: '2026-01-01T00:00:00Z', actor_name: 'A', action, entity_type: 'user', entity_id: null, ip: null });
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

it('ignores a superseded response after the filter changes', async () => {
  const first = deferred<ReturnType<typeof row>[]>();
  const second = deferred<ReturnType<typeof row>[]>();
  listAudit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(<Audit />);
  await waitFor(() => expect(screen.getByRole('combobox', { name: /record type/i })).toBeTruthy());
  await userEvent.click(screen.getByRole('combobox', { name: /record type/i }));
  fireEvent.mouseDown(await screen.findByRole('button', { name: 'user' }));
  await waitFor(() => expect(listAudit).toHaveBeenCalledTimes(2));
  second.resolve([row(2, 'new.action')]);
  await screen.findByText('new.action');
  first.resolve([row(1, 'old.action')]);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('old.action')).toBeNull();
  expect(screen.getByText('new.action')).toBeTruthy();
});

it('disables Load more while a request is in flight', async () => {
  const page = Array.from({ length: 100 }, (_, i) => row(i + 1, `act.${i + 1}`));
  const next = deferred<ReturnType<typeof row>[]>();
  listAudit.mockResolvedValueOnce(page).mockReturnValueOnce(next.promise);
  render(<Audit />);
  const btn = await screen.findByRole('button', { name: /load more/i });
  await userEvent.click(btn);
  await waitFor(() => expect(screen.getByRole('button', { name: /load more/i }).hasAttribute('disabled')).toBe(true));
  await userEvent.click(screen.getByRole('button', { name: /load more/i }));
  expect(listAudit).toHaveBeenCalledTimes(2);
  next.resolve([row(101, 'act.101')]);
  await screen.findByText('act.101');
});
