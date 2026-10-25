// @vitest-environment jsdom
/**
 * lib/usePagedList.ts: page 1 on any query change, debounced search, stale
 * response drops, loadMore paging, rows kept while reloading, error state.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePagedList, type PagedFetchParams, type PagedResponse } from './usePagedList';

interface Q { sort: string; dir: 'asc' | 'desc'; since?: string }
type Row = { id: number };

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function page(ids: number[], next: string | null, total = 100): PagedResponse<Row> {
  return { rows: ids.map((id) => ({ id })), next_cursor: next, total };
}

const base: Q = { sort: 'scanned', dir: 'desc' };

describe('usePagedList', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('loads page 1 on mount with the query, empty search and no cursor', async () => {
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>, _s: AbortSignal) => page([1, 2], 'c1'));
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toEqual({ ...base, search: '', cursor: null });
    expect(fetchPage.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(result.current.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.current.total).toBe(100);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('reloads page 1 when sort, direction or an extra param changes, but not on a same-valued new object', async () => {
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => page([1], null));
    const { result, rerender } = renderHook(
      ({ query }: { query: Q }) => usePagedList<Row, Q>({ fetchPage, query }),
      { initialProps: { query: base } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ query: { ...base } }); // same contents, new identity
    expect(fetchPage).toHaveBeenCalledTimes(1);

    rerender({ query: { ...base, sort: 'device' } });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[1][0]).toMatchObject({ sort: 'device', cursor: null });

    rerender({ query: { sort: 'device', dir: 'asc' } });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    expect(fetchPage.mock.calls[2][0]).toMatchObject({ dir: 'asc' });

    rerender({ query: { sort: 'device', dir: 'asc', since: '2026-10-01T00:00:00Z' } });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(4));
    expect(fetchPage.mock.calls[3][0]).toMatchObject({ since: '2026-10-01T00:00:00Z' });
  });

  it('debounces the search, then reloads page 1 once with the final text', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => page([1], null));
    const { rerender } = renderHook(
      ({ search }: { search: string }) => usePagedList<Row, Q>({ fetchPage, query: base, search }),
      { initialProps: { search: '' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    rerender({ search: 'a' });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    rerender({ search: 'ab' });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(fetchPage).toHaveBeenCalledTimes(1); // still inside the debounce window
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toMatchObject({ search: 'ab', cursor: null });
  });

  it('drops a stale response that lands after a newer request, and aborts it', async () => {
    const first = deferred<PagedResponse<Row>>();
    const second = deferred<PagedResponse<Row>>();
    const signals: AbortSignal[] = [];
    const fetchPage = vi.fn((_p: PagedFetchParams<Q>, signal: AbortSignal) => {
      signals.push(signal);
      return fetchPage.mock.calls.length === 1 ? first.promise : second.promise;
    });
    const { result, rerender } = renderHook(
      ({ query }: { query: Q }) => usePagedList<Row, Q>({ fetchPage, query }),
      { initialProps: { query: base } },
    );
    rerender({ query: { ...base, sort: 'device' } });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);

    await act(async () => { second.resolve(page([20], null, 1)); });
    await act(async () => { first.resolve(page([10], null, 5)); });
    expect(result.current.rows).toEqual([{ id: 20 }]);
    expect(result.current.total).toBe(1);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the current rows visible (reloading) while the next query loads', async () => {
    const next = deferred<PagedResponse<Row>>();
    const fetchPage = vi.fn((_p: PagedFetchParams<Q>) =>
      fetchPage.mock.calls.length === 1 ? Promise.resolve(page([1, 2], null)) : next.promise);
    const { result, rerender } = renderHook(
      ({ query }: { query: Q }) => usePagedList<Row, Q>({ fetchPage, query }),
      { initialProps: { query: base } },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.reloading).toBe(false);

    rerender({ query: { ...base, dir: 'asc' } });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.reloading).toBe(true);
    expect(result.current.rows).toEqual([{ id: 1 }, { id: 2 }]);

    await act(async () => { next.resolve(page([3], null, 1)); });
    expect(result.current.rows).toEqual([{ id: 3 }]);
    expect(result.current.reloading).toBe(false);
  });

  it('loadMore appends the next page with the cursor, then stops when next_cursor is null', async () => {
    const fetchPage = vi.fn(async (p: PagedFetchParams<Q>) => {
      if (p.cursor === null) return page([1, 2], 'c1', 5);
      if (p.cursor === 'c1') return page([3, 4], 'c2', 5);
      return page([5], null, 5);
    });
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(5));
    expect(result.current.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchPage.mock.calls.map((c) => c[0].cursor)).toEqual([null, 'c1', 'c2']);

    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('loadMore is a no-op while a load is in flight', async () => {
    const more = deferred<PagedResponse<Row>>();
    const fetchPage = vi.fn((p: PagedFetchParams<Q>) =>
      p.cursor === null ? Promise.resolve(page([1], 'c1')) : more.promise);
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    act(() => result.current.loadMore());
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.loadingMore).toBe(true);
    await act(async () => { more.resolve(page([2], null)); });
    expect(result.current.loadingMore).toBe(false);
  });

  it('a query change during loadMore discards the late page', async () => {
    const more = deferred<PagedResponse<Row>>();
    const fetchPage = vi.fn((p: PagedFetchParams<Q>) => {
      if (p.cursor === 'c1') return more.promise;
      return Promise.resolve(p.sort === 'scanned' ? page([1], 'c1') : page([9], null, 1));
    });
    const { result, rerender } = renderHook(
      ({ query }: { query: Q }) => usePagedList<Row, Q>({ fetchPage, query }),
      { initialProps: { query: base } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    rerender({ query: { ...base, sort: 'device' } });
    await waitFor(() => expect(result.current.rows).toEqual([{ id: 9 }]));
    await act(async () => { more.resolve(page([2], null)); });
    expect(result.current.rows).toEqual([{ id: 9 }]);
    expect(result.current.loadingMore).toBe(false);
  });

  it('exposes a page-1 failure and clears the rows; reload recovers', async () => {
    let fail = true;
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => {
      if (fail) throw new Error('boom');
      return page([1], null, 1);
    });
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.rows).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);

    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: 1 }]));
    expect(result.current.error).toBeNull();
  });

  it('a loadMore failure keeps the rows and cursor; retry() tries that page again', async () => {
    let fail = true;
    const fetchPage = vi.fn(async (p: PagedFetchParams<Q>) => {
      if (p.cursor === null) return page([1], 'c1');
      if (fail) throw new Error('later');
      return page([2], null);
    });
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe('later'));
    expect(result.current.rows).toEqual([{ id: 1 }]);
    expect(result.current.hasMore).toBe(true);

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: 1 }, { id: 2 }]));
    expect(result.current.error).toBeNull();
  });

  it('loadMore is a no-op after a loadMore failure (no tight retry loop) until retry() or reload()', async () => {
    let failMore = true;
    const fetchPage = vi.fn(async (p: PagedFetchParams<Q>) => {
      if (p.cursor === null) return page([1], 'c1');
      if (failMore) throw new Error('later');
      return page([2], null);
    });
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe('later'));
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // an auto-trigger near the end of the list keeps calling loadMore
    for (let i = 0; i < 5; i++) act(() => result.current.loadMore());
    await act(async () => { await Promise.resolve(); });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('later');

    // retry() is the way out; failing again blocks loadMore again
    act(() => result.current.retry());
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(3);

    // reload() clears the block too
    failMore = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: 1 }, { id: 2 }]));
  });

  it('loadMore reuses the query and search of the page 1 it continues, not a newer pending search', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn(async (p: PagedFetchParams<Q>) =>
      p.cursor === null ? page([1], 'c1') : page([2], null));
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => usePagedList<Row, Q>({ fetchPage, query: base, search }),
      { initialProps: { search: 'a' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    rerender({ search: 'ab' }); // typed, still inside the debounce window
    act(() => result.current.loadMore());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchPage.mock.calls[1][0]).toEqual({ ...base, search: 'a', cursor: 'c1' });
  });

  it('reports loading in the same render that a query or enabled change lands, with no idle frame', async () => {
    const seen: boolean[] = [];
    const fetchPage = vi.fn((_p: PagedFetchParams<Q>) =>
      fetchPage.mock.calls.length === 1 ? Promise.resolve(page([1], null)) : new Promise<PagedResponse<Row>>(() => {}));
    const { result, rerender } = renderHook(
      ({ query, enabled }: { query: Q; enabled: boolean }) => {
        const list = usePagedList<Row, Q>({ fetchPage, query, enabled });
        seen.push(list.loading);
        return list;
      },
      { initialProps: { query: base, enabled: true } },
    );
    expect(seen[0]).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    seen.length = 0;
    rerender({ query: { ...base, sort: 'device' }, enabled: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);        // never false in between
    expect(result.current.reloading).toBe(true);   // old rows still shown

    // disabling reports idle at once; re-enabling reports loading at once
    rerender({ query: { ...base, sort: 'device' }, enabled: false });
    expect(result.current.loading).toBe(false);
    seen.length = 0;
    rerender({ query: { ...base, sort: 'device' }, enabled: true });
    expect(seen.every(Boolean)).toBe(true);
  });

  it('reload re-fetches page 1 with the current query', async () => {
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => page([1], null));
    const { result } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reload());
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[1][0]).toEqual({ ...base, search: '', cursor: null });
  });

  it('reload() does not fetch while disabled', async () => {
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => page([1], null));
    const { result } = renderHook(() =>
      usePagedList<Row, Q>({ fetchPage, query: base, enabled: false }));
    act(() => result.current.reload());
    await act(async () => { await Promise.resolve(); });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch while disabled, and loads once enabled', async () => {
    const fetchPage = vi.fn(async (_p: PagedFetchParams<Q>) => page([1], null));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePagedList<Row, Q>({ fetchPage, query: base, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
  });

  it('aborts the in-flight request on unmount', async () => {
    let signal!: AbortSignal;
    const fetchPage = vi.fn((_p: PagedFetchParams<Q>, s: AbortSignal) => {
      signal = s;
      return new Promise<PagedResponse<Row>>(() => {});
    });
    const { unmount } = renderHook(() => usePagedList<Row, Q>({ fetchPage, query: base }));
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
