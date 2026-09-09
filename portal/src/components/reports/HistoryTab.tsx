/** Placeholder for the History tab — the real run list (polling, status
 *  chips, download, notify toggle, highlight-on-deep-link) lands in Task
 *  9. It already loads the runs once so the tab's count badge is right
 *  and the page's tab wiring is exercised. */
import { useEffect } from 'react';

import { listReportRuns } from '../../lib/api';

export default function HistoryTab({ onCount }: {
  highlightRunId: string | null;
  onCount: (n: number) => void;
}) {
  useEffect(() => {
    let live = true;
    void listReportRuns()
      .then((runs) => { if (live) onCount(runs.length); })
      .catch(() => { /* Task 9 owns the error surface */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
