// @vitest-environment jsdom
/**
 * useDeviceWatches — the person's own device watches for the readers and routers lists' row
 * menus. It loads the list once and keeps only the person's own device watches (a group's watch
 * and any other kind of thing do not count), and `toggle` starts or stops a watch with the same
 * calls and the same words as the Watch button: a failure toasts "Couldn't update your watch.",
 * or the read-only message; a watch already made or already gone reads the list again and says
 * nothing.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, type Watch } from '../../lib/api';

const api = vi.hoisted(() => ({
  listMyWatches: vi.fn(),
  createMyWatch: vi.fn(),
  deleteMyWatch: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const toast = vi.hoisted(() => vi.fn());

vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const { useDeviceWatches } = await import('./useDeviceWatches');

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const WATCH_A = '33333333-3333-4333-8333-333333333333';
const FAILED = "Couldn't update your watch.";

/** The person's own watch of a device. */
function watchOf(deviceId: string, id: string, over: Partial<Watch> = {}): Watch {
  return {
    id, thing: 'device', thing_id: deviceId, thing_name: 'Device A',
    link: `/hardware/kiosks/${deviceId}`, kinds: [], via: { type: 'you', id: null, name: null },
    created_at: '2026-11-02T12:00:00Z', ...over,
  };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Mounts the hook and waits for its first read to land. */
async function mounted() {
  const view = renderHook(() => useDeviceWatches());
  await waitFor(() => expect(api.listMyWatches).toHaveBeenCalledTimes(1));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listMyWatches.mockResolvedValue([]);
  api.createMyWatch.mockResolvedValue(watchOf(DEVICE_A, WATCH_A));
  api.deleteMyWatch.mockResolvedValue(undefined);
});

it('reads the list once and keeps only the person\'s own watches of devices', async () => {
  api.listMyWatches.mockResolvedValue([
    watchOf(DEVICE_A, WATCH_A),
    // a group's watch of a device does not count as the person's own
    watchOf(DEVICE_B, 'w-group', { via: { type: 'group', id: 'g1', name: 'Group A' } }),
    // a watch of another kind of thing that happens to carry the id does not count either
    watchOf('i1', 'w-initiative', { thing: 'initiative', link: '/initiatives/i1' }),
    watchOf(DEVICE_B, 'w-everything', { thing: 'everything', thing_id: null, link: null }),
  ]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watching(DEVICE_A)).toBe(true));

  expect(result.current.watching(DEVICE_B)).toBe(false);
  expect(result.current.watching('i1')).toBe(false);
  expect(result.current.busy(DEVICE_A)).toBe(false);
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a list that does not load counts as watching nothing', async () => {
  api.listMyWatches.mockRejectedValue(new ApiError(500, 'unknown_error'));
  const { result } = await mounted();

  expect(result.current.watching(DEVICE_A)).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it('toggle starts a watch on every event, then reads the list again', async () => {
  api.listMyWatches
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([watchOf(DEVICE_A, WATCH_A)]);
  const { result } = await mounted();
  expect(result.current.watching(DEVICE_A)).toBe(false);

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
  expect(api.createMyWatch).toHaveBeenCalledWith({ thing: 'device', id: DEVICE_A, kinds: [] });
  expect(api.deleteMyWatch).not.toHaveBeenCalled();
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(result.current.watching(DEVICE_A)).toBe(true);
  expect(result.current.watching(DEVICE_B)).toBe(false);
  expect(result.current.busy(DEVICE_A)).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it('toggle stops the watch they have, by its id, then reads the list again', async () => {
  api.listMyWatches
    .mockResolvedValueOnce([watchOf(DEVICE_A, WATCH_A)])
    .mockResolvedValueOnce([]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watching(DEVICE_A)).toBe(true));

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(api.deleteMyWatch).toHaveBeenCalledTimes(1);
  expect(api.deleteMyWatch).toHaveBeenCalledWith(WATCH_A);
  expect(api.createMyWatch).not.toHaveBeenCalled();
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(result.current.watching(DEVICE_A)).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it('toggle takes the list as it reads it again: the person\'s other watches are kept', async () => {
  api.listMyWatches
    .mockResolvedValueOnce([watchOf(DEVICE_B, 'w-b')])
    .mockResolvedValueOnce([watchOf(DEVICE_B, 'w-b'), watchOf(DEVICE_A, WATCH_A)]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watching(DEVICE_B)).toBe(true));

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(result.current.watching(DEVICE_A)).toBe(true);
  expect(result.current.watching(DEVICE_B)).toBe(true);
});

it('busy is true for that device while its toggle is on the way, and a second click does nothing', async () => {
  const create = deferred<Watch>();
  api.createMyWatch.mockReturnValue(create.promise);
  const { result } = await mounted();

  let first!: Promise<void>;
  act(() => { first = result.current.toggle(DEVICE_A); });
  expect(result.current.busy(DEVICE_A)).toBe(true);
  expect(result.current.busy(DEVICE_B)).toBe(false);

  await act(async () => { await result.current.toggle(DEVICE_A); });     // ignored while busy
  expect(api.createMyWatch).toHaveBeenCalledTimes(1);

  await act(async () => { create.resolve(watchOf(DEVICE_A, WATCH_A)); await first; });
  expect(result.current.busy(DEVICE_A)).toBe(false);
});

it('a failure toasts "Couldn\'t update your watch." and leaves the watch as it was', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(500, 'unknown_error'));
  const { result } = await mounted();

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(FAILED);
  expect(result.current.watching(DEVICE_A)).toBe(false);
  expect(result.current.busy(DEVICE_A)).toBe(false);
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);      // nothing changed: nothing to read again
});

it('a failure to stop a watch toasts the same words and keeps the watch', async () => {
  api.listMyWatches.mockResolvedValue([watchOf(DEVICE_A, WATCH_A)]);
  api.deleteMyWatch.mockRejectedValue(new Error('Failed to fetch'));
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watching(DEVICE_A)).toBe(true));

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(toast).toHaveBeenCalledWith(FAILED);
  expect(result.current.watching(DEVICE_A)).toBe(true);
  expect(result.current.busy(DEVICE_A)).toBe(false);
});

it('read-only maintenance toasts the server\'s own message', async () => {
  api.createMyWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', undefined, READ_ONLY_MESSAGE));
  const { result } = await mounted();

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(READ_ONLY_MESSAGE);
});

it('an already_watching answer reads the list again and says nothing', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.listMyWatches
    .mockResolvedValueOnce([])                                // the screen is out of date
    .mockResolvedValueOnce([watchOf(DEVICE_A, WATCH_A)]);     // made in another tab
  const { result } = await mounted();
  expect(result.current.watching(DEVICE_A)).toBe(false);

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(result.current.watching(DEVICE_A)).toBe(true);
  expect(result.current.busy(DEVICE_A)).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it('a watch_not_found answer reads the list again and says nothing', async () => {
  api.deleteMyWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listMyWatches
    .mockResolvedValueOnce([watchOf(DEVICE_A, WATCH_A)])      // the screen is out of date
    .mockResolvedValueOnce([]);                               // stopped in another tab
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watching(DEVICE_A)).toBe(true));

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(result.current.watching(DEVICE_A)).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it('an out-of-date answer whose re-read fails cannot tell which way it is: it says so', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.listMyWatches
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
  const { result } = await mounted();

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(FAILED);
  expect(result.current.watching(DEVICE_A)).toBe(false);
  expect(result.current.busy(DEVICE_A)).toBe(false);
});

it('a change that went through shows even if the list cannot be read again, and says nothing', async () => {
  api.listMyWatches
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
  const { result } = await mounted();

  await act(async () => { await result.current.toggle(DEVICE_A); });

  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
  expect(result.current.watching(DEVICE_A)).toBe(true);     // what the server just answered
  expect(toast).not.toHaveBeenCalled();
});

it('a first read that lands after a toggle does not undo it', async () => {
  const first = deferred<Watch[]>();
  api.listMyWatches
    .mockReturnValueOnce(first.promise)                       // the page's first read, still on its way
    .mockResolvedValueOnce([watchOf(DEVICE_A, WATCH_A)]);     // the read after the toggle
  const { result } = renderHook(() => useDeviceWatches());

  await act(async () => { await result.current.toggle(DEVICE_A); });
  expect(result.current.watching(DEVICE_A)).toBe(true);

  await act(async () => { first.resolve([]); await first.promise; });   // the old answer: no watch yet
  expect(result.current.watching(DEVICE_A)).toBe(true);
});
