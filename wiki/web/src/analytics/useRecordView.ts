/** Counts one view of a page or file per time it's shown, for the
 *  analytics page. The view is sent once the reader has stayed
 *  VIEW_DWELL_MS — a click straight through the tree doesn't count —
 *  and whether to count at all is decided when the node first shows: an
 *  editor who opened the page in the editor (their own edit session) is
 *  never counted, even after switching to View. The dwell timer is also
 *  what keeps StrictMode's mount → unmount → mount from counting twice:
 *  the first timer is cleared before it fires. Failures are ignored — a
 *  view is telemetry. */
import { useEffect } from 'react';

import { recordView } from '../lib/wikiApi';

export const VIEW_DWELL_MS = 1500;

export function useRecordView(nodeId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => { recordView(nodeId).catch(() => {}); }, VIEW_DWELL_MS);
    return () => clearTimeout(timer);
    // `enabled` is read only when the node first shows (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
}
