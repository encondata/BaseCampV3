/** Runs a load when the page opens (and whenever `deps` change), keeping
 *  the answer, a loading flag and the failure. A 401 is not an error to
 *  show: learnFetch is already sending the worker back to sign-in. */
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@portal/lib/api';

interface Loaded<T> { data: T | null; error: ApiError | null; loading: boolean }

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    load().then(
      (data) => { if (live) setState({ data, error: null, loading: false }); },
      (err: unknown) => {
        if (!live) return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'unknown');
        setState({ data: null, error: error.status === 401 ? null : error, loading: error.status === 401 });
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, round]);

  return { ...state, reload };
}
