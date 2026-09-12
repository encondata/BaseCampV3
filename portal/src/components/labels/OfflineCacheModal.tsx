/**
 * Print Labels › Offline labels — what the IndexedDB cache holds (one row
 * per initiative + label type), a Download row for the initiative picked
 * on the page, and Clear all. Presentational: the page performs the cache
 * and API calls and passes the results back in.
 */
import { useEffect, useRef, useState } from 'react';

import { relativeTime } from '../../lib/format';
import type { CachedBundleSummary } from '../../lib/labelCache';
import DataTable from '../DataTable';

interface Props {
  bundles: CachedBundleSummary[];
  selectedInitiative: { id: string; name: string } | null;
  labelTypes: { key: string; label: string }[];
  downloading: boolean;
  downloadStatus: string | null;
  onDownload: (labelTypes: string[]) => Promise<void>;
  onRemove: (initiativeId: string, labelType: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onClose: () => void;
}

export default function OfflineCacheModal({
  bundles, selectedInitiative, labelTypes, downloading, downloadStatus,
  onDownload, onRemove, onClearAll, onClose,
}: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(labelTypes.map((t) => t.key)));
  const [confirmClear, setConfirmClear] = useState(false);
  const touched = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !downloading) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, downloading]);

  // Types can arrive after mount (vocab still loading, or offline) — keep
  // "all checked" for any type the user hasn't touched yet.
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const t of labelTypes) if (!touched.current.has(t.key)) next.add(t.key);
      return next;
    });
  }, [labelTypes]);

  const typeLabel = (key: string) => labelTypes.find((t) => t.key === key)?.label ?? key;

  const rows = [...bundles]
    .sort((a, b) => a.initiative_name.localeCompare(b.initiative_name) || a.label_type.localeCompare(b.label_type))
    .map((b) => ({
      key: `${b.initiative_id}:${b.label_type}`,
      cells: [
        <b className="cell-top" key="n">{b.initiative_name}</b>,
        <span className="chip tag" key="t">{typeLabel(b.label_type)}</span>,
        <span className="mono" key="c">{b.label_count}</span>,
        <span className="mono" key="d">{relativeTime(b.cached_at)}</span>,
        <button type="button" className="mini-btn" key="r" disabled={downloading}
                onClick={() => void onRemove(b.initiative_id, b.label_type)}>Remove</button>,
      ],
    }));

  const toggle = (key: string) => {
    touched.current.add(key);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const totalLabels = bundles.reduce((n, b) => n + b.label_count, 0);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !downloading) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card plabels-cache-card" role="dialog" aria-label="Offline labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Offline labels</h3>
            <p className="page-hint">
              Labels downloaded here print even when the network is down. Every initiative you open online is cached automatically.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={downloading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">Cached bundles</div>
          {bundles.length === 0
            ? <div className="dir-empty">Nothing cached yet.</div>
            : (
              <DataTable ariaLabel="Cached label bundles"
                columns={[
                  { key: 'initiative', label: 'Initiative', width: '2fr' },
                  { key: 'type', label: 'Label type', width: '1fr' },
                  { key: 'count', label: 'Labels', width: '0.6fr', align: 'right', mono: true },
                  { key: 'age', label: 'Downloaded', width: '0.8fr', mono: true },
                  { key: 'remove', label: '', width: '0.6fr', align: 'right' },
                ]}
                rows={rows} />
            )}
          <div className="plabels-cache-download" style={{ marginTop: 14 }}>
            {selectedInitiative ? (
              <>
                <div className="modal-section">Download for {selectedInitiative.name}</div>
                <div className="plabels-cache-types">
                  {labelTypes.map((t) => (
                    <label key={t.key}>
                      <input type="checkbox" checked={checked.has(t.key)} disabled={downloading}
                             aria-label={t.label} onChange={() => toggle(t.key)} />
                      <span className="cell-sub">{t.label}</span>
                    </label>
                  ))}
                </div>
                <div className="plabels-cache-actions">
                  <button type="button" className="btn-solid" disabled={downloading || checked.size === 0}
                          onClick={() => void onDownload(labelTypes.map((t) => t.key).filter((k) => checked.has(k)))}>
                    {downloading ? 'Downloading…' : 'Download'}
                  </button>
                  {downloadStatus && <span className="cell-sub">{downloadStatus}</span>}
                </div>
              </>
            ) : (
              <p className="page-hint">Pick an initiative on the page to download its labels.</p>
            )}
          </div>
        </div>
        <div className="modal-foot">
          {confirmClear ? (
            <>
              <span className="cell-sub">Remove all {bundles.length} cached bundles ({totalLabels} labels)?</span>
              <button type="button" className="mini-btn danger" disabled={downloading}
                      onClick={() => { setConfirmClear(false); void onClearAll(); }}>Yes, clear the cache</button>
              <button type="button" className="mini-btn" onClick={() => setConfirmClear(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="mini-btn danger" disabled={downloading || bundles.length === 0}
                    onClick={() => setConfirmClear(true)}>Clear all</button>
          )}
          <button type="button" className="btn-solid" onClick={onClose} disabled={downloading}>Done</button>
        </div>
      </div>
    </div>
  );
}
