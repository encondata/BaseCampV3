/** Runs a load when the page opens (and whenever `deps` change), keeping
 *  the answer, a loading flag and the failure. A 401 is not an error to
 *  show: learnFetch is already sending the worker back to sign-in.
 *  Options: `enabled: false` loads nothing (someone else has the data);
 *  `keepData` keeps the last answer on screen while a reload runs, and
 *  through a failed one (the error shows only when there is no answer). */
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@portal/lib/api';

interface Loaded<T> { data: T | null; error: ApiError | null; loading: boolean }

export type UseLoad<T> = Loaded<T> & { reload: () => void };

export interface LoadOptions { enabled?: boolean; keepData?: boolean }

export function useLoad<T>(
  load: () => Promise<T>, deps: unknown[], { enabled = true, keepData = false }: LoadOptions = {},
): UseLoad<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const kept = (s: Loaded<T>) => keepData && s.data !== null;
    setState((s) => (kept(s) ? { ...s, loading: true } : { data: null, error: null, loading: true }));
    load().then(
      (data) => { if (live) setState({ data, error: null, loading: false }); },
      (err: unknown) => {
        if (!live) return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'unknown');
        setState((s) => (kept(s) ? { ...s, loading: false }
          : { data: null, error: error.status === 401 ? null : error, loading: error.status === 401 }));
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, round, enabled, keepData]);

  return { ...state, reload };
}
