// @vitest-environment jsdom
/**
 * useAssetWatches — the person's own asset watches, for the row menus of the Assets list and the
 * initiative's asset list ("Watch…" or "Watching…"). It reads the list once (and again on
 * `reload`), and `watchFor` finds the watch on an asset in one place: on its own, or on one
 * initiative. A list that does not load counts as watching nothing.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type AssetWatch } from '../../lib/api';

const api = vi.hoisted(() => ({
  listMyAssetWatches: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { useAssetWatches } = await import('./useAssetWatches');

const ASSET_A = '11111111-1111-4111-8111-111111111111';
const ASSET_B = '22222222-2222-4222-8222-222222222222';
const INITIATIVE_X = '33333333-3333-4333-8333-333333333333';
const INITIATIVE_Y = '44444444-4444-4444-8444-444444444444';

/** A watch of the asset, on its own, or on `initiativeId`. */
function watchOf(
  id: string, assetId: string, initiativeId: string | null = null, over: Partial<AssetWatch> = {},
): AssetWatch {
  return {
    id, asset_id: assetId, asset_name: 'SN-1001',
    initiative_id: initiativeId, initiative_name: initiativeId ? 'Initiative X' : null,
    initiative_asset_id: initiativeId ? 'row-1' : null,
    condition: 'next_update', status: null, status_label: null,
    current_status: 'in_storage', current_status_label: 'In storage',
    link: initiativeId ? `/initiatives/${initiativeId}/assets/row-1` : `/assets/${assetId}`,
    created_at: '2026-11-05T12:00:00Z', ...over,
  };
}

const OWN_A = watchOf('w-own-a', ASSET_A);
const ON_X = watchOf('w-on-x', ASSET_A, INITIATIVE_X);
const OWN_B = watchOf('w-own-b', ASSET_B);

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Mounts the hook and waits for its first read to land. */
async function mounted() {
  const view = renderHook(() => useAssetWatches());
  await waitFor(() => expect(api.listMyAssetWatches).toHaveBeenCalledTimes(1));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listMyAssetWatches.mockResolvedValue([]);
});

it('reads the person\'s asset watches once, and hands them over as they came', async () => {
  api.listMyAssetWatches.mockResolvedValue([OWN_A, ON_X]);
  const { result } = await mounted();

  await waitFor(() => expect(result.current.watches).toEqual([OWN_A, ON_X]));
  expect(api.listMyAssetWatches).toHaveBeenCalledTimes(1);
});

it('has no watches, and finds none, until the list lands', async () => {
  const pending = deferred<AssetWatch[]>();
  api.listMyAssetWatches.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useAssetWatches());

  expect(result.current.watches).toEqual([]);
  expect(result.current.watchFor(ASSET_A)).toBeUndefined();

  await act(async () => { pending.resolve([OWN_A]); });
  expect(result.current.watchFor(ASSET_A)).toBe(OWN_A);
});

it('watchFor finds the watch on an asset on its own', async () => {
  api.listMyAssetWatches.mockResolvedValue([OWN_A, ON_X, OWN_B]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watches).toHaveLength(3));

  expect(result.current.watchFor(ASSET_A)).toBe(OWN_A);
  expect(result.current.watchFor(ASSET_B)).toBe(OWN_B);
});

it('watchFor finds the watch on an asset on an initiative, and not the one on the asset itself', async () => {
  api.listMyAssetWatches.mockResolvedValue([OWN_A, ON_X]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watches).toHaveLength(2));

  expect(result.current.watchFor(ASSET_A, INITIATIVE_X)).toBe(ON_X);
});

it('the place counts: a watch on an initiative is not found on the asset itself or on another initiative', async () => {
  api.listMyAssetWatches.mockResolvedValue([ON_X]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watches).toHaveLength(1));

  expect(result.current.watchFor(ASSET_A)).toBeUndefined();
  expect(result.current.watchFor(ASSET_A, INITIATIVE_Y)).toBeUndefined();
  expect(result.current.watchFor(ASSET_A, INITIATIVE_X)).toBe(ON_X);
});

it('the asset counts: a watch on one asset is not found for another', async () => {
  api.listMyAssetWatches.mockResolvedValue([OWN_A, ON_X]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watches).toHaveLength(2));

  expect(result.current.watchFor(ASSET_B)).toBeUndefined();
  expect(result.current.watchFor(ASSET_B, INITIATIVE_X)).toBeUndefined();
});

it('no initiative, null and undefined are all the same place: the asset itself', async () => {
  api.listMyAssetWatches.mockResolvedValue([OWN_A, ON_X]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watches).toHaveLength(2));

  expect(result.current.watchFor(ASSET_A)).toBe(OWN_A);
  expect(result.current.watchFor(ASSET_A, null)).toBe(OWN_A);
  expect(result.current.watchFor(ASSET_A, undefined)).toBe(OWN_A);
});

it('a list that does not load counts as watching nothing', async () => {
  api.listMyAssetWatches.mockRejectedValue(new ApiError(500, 'unknown_error'));
  const { result } = await mounted();

  await act(async () => { await Promise.resolve(); });
  expect(result.current.watches).toEqual([]);
  expect(result.current.watchFor(ASSET_A)).toBeUndefined();
});

it('reload reads the list again and shows what is true now', async () => {
  api.listMyAssetWatches.mockResolvedValueOnce([OWN_A]).mockResolvedValueOnce([OWN_B]);
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watchFor(ASSET_A)).toBe(OWN_A));

  act(() => { result.current.reload(); });

  await waitFor(() => expect(result.current.watchFor(ASSET_B)).toBe(OWN_B));
  expect(result.current.watchFor(ASSET_A)).toBeUndefined();
  expect(api.listMyAssetWatches).toHaveBeenCalledTimes(2);
});

it('a reload that fails leaves the list as it was', async () => {
  api.listMyAssetWatches.mockResolvedValueOnce([OWN_A]).mockRejectedValueOnce(new Error('Failed to fetch'));
  const { result } = await mounted();
  await waitFor(() => expect(result.current.watchFor(ASSET_A)).toBe(OWN_A));

  act(() => { result.current.reload(); });
  await waitFor(() => expect(api.listMyAssetWatches).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });

  expect(result.current.watchFor(ASSET_A)).toBe(OWN_A);
});

it('only the newest read counts: an older answer that arrives late is dropped', async () => {
  const first = deferred<AssetWatch[]>();
  const second = deferred<AssetWatch[]>();
  api.listMyAssetWatches.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = renderHook(() => useAssetWatches());
  act(() => { result.current.reload(); });

  await act(async () => { second.resolve([OWN_B]); });
  await act(async () => { first.resolve([OWN_A]); });          // the first read, late

  expect(result.current.watches).toEqual([OWN_B]);
});

it('reload is the same function on every render', async () => {
  const { result, rerender } = await mounted();
  const first = result.current.reload;

  rerender();

  expect(result.current.reload).toBe(first);
});
