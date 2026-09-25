// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, SiteItem, StatusValue } from '../../lib/api';
import { formFromInitiative } from '../../lib/initiatives';
import { EMPTY_LOOKUPS } from '../../lib/moveSetup';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, preferences: { list_prefs: {} } }),
}));
const api = vi.hoisted(() => ({ createMoveFromSetup: vi.fn(), getMoveSetup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { ApiError } = await import('../../lib/api');
const { default: ReviewStep } = await import('./ReviewStep');

const LOOKUPS = {
  ...EMPTY_LOOKUPS,
  sites: [{ id: 's1', name: 'San Jose DC' }, { id: 's2', name: 'Dallas DC' }] as SiteItem[],
  containerTypes: [{ key: 'pallet', label: 'Pallet' }] as StatusValue[],
};
const FORM = { ...formFromInitiative(null), initiative_type: 'move', name: 'SJC to DAL',
               origin_site_id: 's1', destination_site_id: 's2' };
const base = (over: Partial<MoveSetupDraft> = {}): MoveSetupDraft => ({
  id: 'd1', status: 'preview', error: null, initiative_id: null, total_rows: 0, processed_rows: 0,
  results: null, created_at: '', previews: null,
  payload: { move: {}, assets: null,
             crates: { convention: 'CRT-xxx', count: 2, start: 1, container_type: 'pallet', tags: { priority: 1 } },
             trucks: null },
  ...over,
});

function Harness({ initial }: { initial: MoveSetupDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <MemoryRouter>
      <ReviewStep draft={draft} onDraft={setDraft} form={FORM} lookups={LOOKUPS} assetJob={null}
                  onBack={vi.fn()} onFinished={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
afterEach(cleanup);

it('summarizes every step, with Skipped for skipped ones', async () => {
  api.getMoveSetup.mockResolvedValue(base());
  render(<Harness initial={base()} />);
  expect(screen.getByText('SJC to DAL')).toBeTruthy();
  expect(screen.getByText('San Jose DC')).toBeTruthy();
  expect(screen.getByText('CRT-001')).toBeTruthy();
  expect(screen.getByText('2 crates · Pallet · 1 Priority · 1 untagged')).toBeTruthy();
  expect(screen.getAllByText('Skipped')).toHaveLength(2);           // assets and trucks
});

it('creates, shows progress, then the finish screen', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValueOnce(base())
    .mockResolvedValueOnce(base({ status: 'running', processed_rows: 1, total_rows: 2 }))
    .mockResolvedValueOnce(base({ status: 'completed', initiative_id: 'm1', payload: null,
      results: { move_id: 'm1', assets: null, crates: 2, trucks: 0 } }));
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();   // queued, no total yet
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Creating… 1 of 2')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Move created')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the move' }).getAttribute('href')).toBe('/initiatives/m1');
  expect(screen.getByText('2 crates created · 0 trucks created')).toBeTruthy();
});

it('a 422 lists the reasons; a failed job says why and stays editable', async () => {
  const user = userEvent.setup();
  api.getMoveSetup.mockResolvedValue(base());
  api.createMoveFromSetup.mockRejectedValueOnce(new ApiError(422, 'setup_invalid',
    { code: 'setup_invalid', reasons: ['Pick a crate type.'] }));
  const { unmount } = render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Pick a crate type.')).toBeTruthy();
  unmount();

  const failed = base({ status: 'failed', error: 'name_taken',
    results: { reasons: ['These truck names already exist: TRK-002.'] } });
  api.getMoveSetup.mockResolvedValue(failed);
  render(<Harness initial={failed} />);
  expect(screen.getByText('These truck names already exist: TRK-002.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Create move' }) as HTMLButtonElement).disabled).toBe(false);
});

it('stops polling once it unmounts', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValue(base({ status: 'running', processed_rows: 1, total_rows: 9 }));
  api.getMoveSetup.mockResolvedValueOnce(base());
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  const { unmount } = render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();
  const calls = api.getMoveSetup.mock.calls.length;
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.getMoveSetup.mock.calls.length).toBe(calls);
});

it('a mount refresh answering after Create never rolls the draft back to preview', async () => {
  const user = userEvent.setup();
  let release!: (d: MoveSetupDraft) => void;
  api.getMoveSetup.mockImplementationOnce(() => new Promise((r) => { release = r; }))
    .mockResolvedValue(base({ status: 'running', processed_rows: 0, total_rows: 0 }));
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();
  await act(async () => { release(base()); });
  expect(screen.getByText('Creating the move…')).toBeTruthy();
});

it('keeps polling through a 502 and reaches the finish screen', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValueOnce(base())                                    // mount refresh
    .mockRejectedValueOnce(new ApiError(502, 'server_error'))                       // first poll: 5xx
    .mockResolvedValueOnce(base({ status: 'completed', initiative_id: 'm1', payload: null,
      results: { move_id: 'm1', assets: null, crates: 2, trucks: 0 } }));           // second poll: done
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.queryByText('Check again')).toBeNull();                             // a 5xx is a blip, not terminal
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Move created')).toBeTruthy();
});

it('a 404 while polling shows the sentence, and Check again restarts polling', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValueOnce(base())                                    // mount refresh
    .mockRejectedValueOnce(new ApiError(404, 'draft_not_found'))                    // first poll: terminal
    .mockResolvedValueOnce(base({ status: 'running', processed_rows: 1, total_rows: 2 }));
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText(
    'This move setup is gone. It may have expired after a day without changes. Start again.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Creating… 1 of 2')).toBeTruthy();
});

it('polling stops on a failed status and shows the reasons while Back and Create stay enabled', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValueOnce(base())
    .mockResolvedValueOnce(base({ status: 'failed', error: 'name_taken',
      results: { reasons: ['These truck names already exist: TRK-002.'] } }));
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('These truck names already exist: TRK-002.')).toBeTruthy();
  const calls = api.getMoveSetup.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.getMoveSetup.mock.calls.length).toBe(calls);                           // a failed status stops polling
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Create move' }) as HTMLButtonElement).disabled).toBe(false);
});
