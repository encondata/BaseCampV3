/**
 * AssetScanHistory — the initiative roster row expansion: the asset's
 * processed-scan history, newest first, latest 15. Lazy: mounts only
 * when the row opens, fetches once. Read-only by design.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { listAssetScans, type AssetScanRow } from '../../lib/api';

const CAP = 15;

export default function AssetScanHistory({ assetId }: { assetId: string }) {
  const [scans, setScans] = useState<AssetScanRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setScans(null);
    setError(false);
    void listAssetScans(assetId)
      .then(setScans)
      .catch(() => setError(true));
  }, [assetId]);

  return (
    <div className="detail-grid">
      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Scan history</p>
        {error && <p className="page-hint">Could not load scan history.</p>}
        {!error && scans === null && <p className="page-hint">Loading…</p>}
        {scans?.length === 0 && (
          <p className="page-hint">No scans recorded for this asset.</p>
        )}
        {scans && scans.length > 0 && (
          <>
            <dl className="kv">
              {scans.map((s) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  <dt className="mono">
                    {new Date(s.scanned_at).toLocaleString()}
                  </dt>
                  <dd>
                    <span className="chip custom"
                          style={{ '--chip': s.scan_type_color } as CSSProperties}>
                      <span className="dot" />{s.scan_type_label}
                    </span>
                    {' '}
                    <span className="mono">{s.device_id || '—'}</span>
                    {' · '}{s.operator_name ?? '—'}
                    {' · '}
                    {[s.site_name, s.location_detail].filter(Boolean).join(' · ') || '—'}
                  </dd>
                </span>
              ))}
            </dl>
            {scans.length === CAP && (
              <p className="page-hint">Latest {CAP} scans shown.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
