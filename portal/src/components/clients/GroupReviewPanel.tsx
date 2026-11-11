/**
 * GroupReviewPanel — the client page's Groups › Review view: distinct
 * unmatched From-To Owner values on this client's moves. Each row offers
 * Match to group…, Create group and Dismiss (Restore for dismissed rows).
 * The parent owns the payload (the Review tab's badge needs it) and the
 * match/create modals; this panel renders it and writes dismiss/restore.
 * Layout and classes follow ModelReviewPanel (rv-*).
 */
import { useState } from 'react';

import { dismissGroupReview, type ReviewValue } from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import '../../styles/assets.css';

export default function GroupReviewPanel({
  clientId, data, loadError, matchDisabled = false, showDismissed, onToggleDismissed, onMatch,
  onCreate, onChanged,
}: {
  clientId: string;
  data: ReviewValue[] | null;
  loadError: string;
  /** Match to group… is off while the parent has no group list to offer. */
  matchDisabled?: boolean;
  showDismissed: boolean;
  onToggleDismissed: (next: boolean) => void;
  onMatch: (value: string) => void;
  onCreate: (value: string) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const dismiss = async (v: ReviewValue, dismissed: boolean) => {
    setBusy(v.value_key);
    setError('');
    try {
      await dismissGroupReview(clientId, { value: v.value, dismissed });
      onChanged();
    } catch (e) {
      setError(groupMsgFor(e));
    } finally {
      setBusy(null);
    }
  };

  const shownError = error || loadError;
  if (shownError && !data) return <div className="dir-empty"><b>Cannot load review</b>{shownError}</div>;
  if (!data) return <p className="page-hint">Loading…</p>;

  const dismissedCount = data.filter((v) => v.dismissed).length;
  const shown = showDismissed ? data : data.filter((v) => !v.dismissed);

  return (
    <div className="rv-panel">
      <label className="init-check rv-toggle">
        <input type="checkbox" checked={showDismissed}
               onChange={(e) => onToggleDismissed(e.target.checked)} />
        Show dismissed ({dismissedCount})
      </label>
      {shownError && <span className="pf-error">{shownError}</span>}
      {shown.length === 0 && (
        <div className="dir-empty"><b>Nothing to review</b>Every Owner value on this client&apos;s moves is matched to a group.</div>
      )}
      {shown.map((v) => (
        <div key={v.value_key} className={`rv-row ${v.dismissed ? 'dismissed' : ''}`}>
          <div className="rv-main">
            <div><b>{v.value}</b></div>
            <span className="rv-meta">
              {v.asset_count} asset{v.asset_count === 1 ? '' : 's'} · {v.move_ids.length} move{v.move_ids.length === 1 ? '' : 's'}
              {v.dismissed && ' · dismissed'}
            </span>
            {v.move_names.length > 0 && <span className="rv-note">{v.move_names.join(', ')}</span>}
          </div>
          <div className="rv-actions">
            <button className="mini-btn accent" data-action="match"
                    disabled={matchDisabled || busy === v.value_key}
                    onClick={() => onMatch(v.value)}>Match to group…</button>
            <button className="mini-btn" data-action="create" disabled={busy === v.value_key}
                    onClick={() => onCreate(v.value)}>Create group</button>
            <button className="mini-btn" data-action={v.dismissed ? 'restore' : 'dismiss'}
                    disabled={busy === v.value_key}
                    onClick={() => void dismiss(v, !v.dismissed)}>{v.dismissed ? 'Restore' : 'Dismiss'}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
