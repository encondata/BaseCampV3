/** The laptop edge's status (cloud reachability, sync, upload queue),
 *  polled while mounted. Outside laptop mode it never fetches and stays
 *  null, so callers can render it unconditionally. A failed poll keeps the
 *  last answer — the edge is on localhost, so a failure is transient. */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getEdgeStatus, type EdgeStatus } from './api';
import { isLaptop } from './platform';

export const EDGE_POLL_MS = 15_000;

export function useEdgeStatus(): { status: EdgeStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    if (!isLaptop()) return;
    try {
      const next = await getEdgeStatus();
      if (live.current) setStatus(next);
    } catch {
      /* keep the last answer */
    }
  }, []);

  useEffect(() => {
    live.current = true;
    if (!isLaptop()) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), EDGE_POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [refresh]);

  return { status, refresh };
}
