/** The expanded entry of a scan on Admin → Scans (Raw and Processed tabs):
 *  a Details | Raw switch over the tab's own read-only details and the scan
 *  as one JSON document (GET /scans/{kind}/{id}/record) — every stored
 *  field, the names behind its ids, the kiosk's own match, the matcher's
 *  trace and, for a processed scan, what it matched and the rules that ran.
 *  For troubleshooting a scan after the fact. The JSON loads when Raw is
 *  first chosen, so the list itself stays light. */

import { useEffect, useState, type ReactNode } from 'react';

import { ApiError, getScanRecord } from '../../lib/api';
import '../../styles/scans.css';

type View = 'details' | 'raw';

export default function ScanDetailViews({ kind, id, children }: {
  kind: 'raw' | 'processed';
  id: string | number;
  /** The Details view: the tab's existing detail grid. */
  children: ReactNode;
}) {
  const [view, setView] = useState<View>('details');
  return (
    <div className="scan-detail-views">
      <div className="segmented" role="tablist" aria-label="Scan view">
        {(['details', 'raw'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v}
                  className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v === 'details' ? 'Details' : 'Raw'}
          </button>
        ))}
      </div>
      {view === 'details' ? children : <ScanRecordJson kind={kind} id={id} />}
    </div>
  );
}

function ScanRecordJson({ kind, id }: { kind: 'raw' | 'processed'; id: string | number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setText(null);
    setError(null);
    getScanRecord(kind, id, ctl.signal)
      .then((record) => setText(JSON.stringify(record, null, 2)))
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'scan_not_found') {
          setError(kind === 'raw'
            ? 'This scan has matched since the list loaded. Find it on the Processed tab.'
            : 'This scan no longer exists.');
        } else {
          setError(`Couldn't load the scan: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    return () => ctl.abort();
  }, [kind, id]);

  const copy = () => {
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (error !== null) return <p className="set-note" role="alert">{error}</p>;
  if (text === null) return <p className="set-note" role="status">Loading…</p>;
  return (
    <div className="scan-json">
      <button type="button" className="mini-btn scan-json-copy" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre aria-label="Scan as JSON">{text}</pre>
    </div>
  );
}
