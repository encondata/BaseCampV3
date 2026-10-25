/**
 * Server-paged list state, generic over the row type and the query inputs.
 *
 * The caller owns the query (sort, direction, column filters, date range, any
 * extra params) and the global search text; this hook owns the rows. Whenever
 * the query or the (debounced) search changes it loads page 1, keeping the
 * rows already on screen until the new ones land. `loadMore()` appends the
 * next page. Responses that arrive after a newer request started are dropped
 * (sequence number), and the superseded request is aborted when the fetcher
 * honors the signal.
 *
 * Nothing here knows about a particular endpoint: Raw scans passes
 * getRawScanPage, Assets and the move rosters can pass theirs later.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** What every paged endpoint returns. */
export interface PagedResponse<T> {
  rows: T[];
  next_cursor: string | null;
  total: number;
}

/** The argument `fetchPage` receives: the caller's query plus the debounced
 *  search text and the cursor (null for page 1). */
export type PagedFetchParams<Q> = Q & { search: string; cursor: string | null };

export interface UsePagedListOptions<T, Q> {
  /** Loads one page. Kept in a ref, so a new function identity each render
   *  does not reload the list. */
  fetchPage: (params: PagedFetchParams<Q>, signal: AbortSignal) => Promise<PagedResponse<T>>;
  /** Sort, dir, filters, date range, page size... Compared by JSON value, so
   *  a fresh object with the same contents does not reload. Not the search. */
  query: Q;
  /** The raw search box text; page 1 reloads `searchDebounceMs` after it
   *  stops changing. */
  search?: string;
  searchDebounceMs?: number;
  /** False holds the list idle (no fetch) until the caller is ready. */
  enabled?: boolean;
}

export interface PagedList<T> {
  rows: T[];
  /** Everything matching the query, from the latest page that landed. */
  total: number;
  /** A page-1 load is in flight (true on the first render when enabled). */
  loading: boolean;
  /** A page-1 load is in flight while rows from the previous query are
   *  still shown. */
  reloading: boolean;
  /** A loadMore() request is in flight. */
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  /** Appends the next page. No-op while a load is in flight or when there is
   *  no next page. */
  loadMore: () => void;
  /** Reloads page 1 with the current query and search. */
  reload: () => void;
}

export const DEFAULT_SEARCH_DEBOUNCE_MS = 250;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function usePagedList<T, Q extends object>(
  { fetchPage, query, search = '', searchDebounceMs = DEFAULT_SEARCH_DEBOUNCE_MS, enabled = true }:
    UsePagedListOptions<T, Q>,
): PagedList<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Debounced search. Starts at the initial text so the first load is not
  // delayed; later edits settle for searchDebounceMs first.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    if (search === debouncedSearch) return;
    const timer = setTimeout(() => setDebouncedSearch(search), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [search, debouncedSearch, searchDebounceMs]);

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const queryKey = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  /** The params page 1 of the current result was loaded with; loadMore reuses
   *  them so a half-typed search never mixes into a later page. */
  const paramsRef = useRef<Q | null>(null);
  const searchRef = useRef(debouncedSearch);
  searchRef.current = debouncedSearch;

  const cancelInFlight = useCallback(() => {
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
  }, []);

  const loadFirst = useCallback(() => {
    cancelInFlight();
    const seq = seqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    const params = queryRef.current;
    const searchText = searchRef.current;
    paramsRef.current = params;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    fetchRef.current({ ...params, search: searchText, cursor: null }, controller.signal)
      .then((page) => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        cursorRef.current = page.next_cursor;
        setRows(page.rows);
        setTotal(page.total);
        setHasMore(page.next_cursor !== null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        // Rows from the previous query would misdescribe this one.
        cursorRef.current = null;
        setRows([]);
        setTotal(0);
        setHasMore(false);
        setError(messageOf(e));
        setLoading(false);
      });
  }, [cancelInFlight]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    const params = paramsRef.current;
    if (cursor === null || params === null || inFlightRef.current) return;
    const seq = seqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    setLoadingMore(true);
    setError(null);
    fetchRef.current({ ...params, search: searchRef.current, cursor }, controller.signal)
      .then((page) => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        cursorRef.current = page.next_cursor;
        setRows((prev) => prev.concat(page.rows));
        setTotal(page.total);
        setHasMore(page.next_cursor !== null);
        setLoadingMore(false);
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return;
        inFlightRef.current = false;
        // Keep the rows and the cursor: calling loadMore again retries.
        setError(messageOf(e));
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      cancelInFlight();
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    loadFirst();
    // loadFirst reads the latest query/search through refs; these are the
    // inputs whose change must start a new page 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, queryKey, debouncedSearch]);

  // Drop anything still in flight on unmount.
  useEffect(() => cancelInFlight, [cancelInFlight]);

  return {
    rows, total, loading,
    reloading: loading && rows.length > 0,
    loadingMore, error, hasMore, loadMore, reload: loadFirst,
  };
}
