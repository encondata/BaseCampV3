/**
 * ModelReviewPanel — the Makes / Models Review view: models the importer
 * created by guessing, and groups of models whose normalized names or
 * aliases collide. Each row offers Merge into…, Edit and Dismiss (Restore
 * for dismissed rows). Data is loaded here; the page bumps `reloadKey`
 * after any catalog write.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, dismissAssetModelReview, reviewAssetModels,
  type AssetModelItem, type ReviewItem, type ReviewOut,
} from '../../lib/api';
import { MODEL_ERRORS } from '../../lib/assets';

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

export default function ModelReviewPanel({ canChange, onMerge, onEdit, reloadKey }: {
  canChange: boolean;
  onMerge: (source: AssetModelItem, presetTargetId: string | null) => void;
  onEdit: (id: string) => void;
  reloadKey: number;
}) {
  const [data, setData] = useState<ReviewOut | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    reviewAssetModels(showDismissed)
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((e) => { if (live) setError(msgFor(e)); });
    return () => { live = false; };
  }, [showDismissed, reloadKey, tick]);

  const dismiss = async (m: ReviewItem, dismissed: boolean) => {
    setBusyId(m.id);
    setError('');
    try {
      await dismissAssetModelReview(m.id, dismissed);
      setTick((t) => t + 1);
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusyId(null);
    }
  };

  const row = (m: ReviewItem, presetTargetId: string | null, note?: string) => {
    const dismissed = m.review_dismissed_at !== null;
    return (
      <div key={m.id} className={`rv-row ${dismissed ? 'dismissed' : ''}`}>
        <div className="rv-main">
          <div><b>{m.make}</b> <span>{m.model}</span></div>
          <span className="rv-meta">{m.asset_count} asset{m.asset_count === 1 ? '' : 's'}
            {m.aliases.length > 0 && ` · ${m.aliases.length} alias${m.aliases.length === 1 ? '' : 'es'}`}
            {dismissed && ' · dismissed'}</span>
          {note && <span className="rv-note">{note}</span>}
        </div>
        {canChange && (
          <div className="rv-actions">
            <button className="mini-btn accent" data-action="merge" disabled={busyId === m.id}
                    onClick={() => onMerge(m, presetTargetId)}>Merge into…</button>
            <button className="mini-btn" data-action="edit" disabled={busyId === m.id}
                    onClick={() => onEdit(m.id)}>Edit</button>
            <button className="mini-btn" data-action={dismissed ? 'restore' : 'dismiss'} disabled={busyId === m.id}
                    onClick={() => void dismiss(m, !dismissed)}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          </div>
        )}
      </div>
    );
  };

  if (error && !data) return <div className="dir-empty"><b>Cannot load review</b>{error}</div>;
  if (!data) return <p className="page-hint">Loading…</p>;
  const empty = data.imported.length === 0 && data.duplicates.length === 0;

  return (
    <div className="rv-panel">
      <label className="init-check rv-toggle">
        <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
        Show dismissed ({data.dismissed_count})
      </label>
      {error && <span className="pf-error">{error}</span>}
      {empty && (
        <div className="dir-empty"><b>Nothing to review</b>Nothing to review — the catalog has no import-created or overlapping models.</div>
      )}
      {data.imported.length > 0 && (
        <section className="rv-section">
          <p className="eyebrow-sm">Created by import</p>
          {data.imported.map((m) => row(m, null, (m.knowledge || '').split('\n')[0]))}
        </section>
      )}
      {data.duplicates.length > 0 && (
        <section className="rv-section">
          <p className="eyebrow-sm">Likely duplicates</p>
          {data.duplicates.map((group) => (
            <div key={group.map((g) => g.id).join('+')} className="rv-group">
              <div className="rv-group-key">matches “{group[0].group_key}”</div>
              {group.map((m) => row(m, group.length === 2 ? group.find((g) => g.id !== m.id)!.id : null))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
