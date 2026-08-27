/**
 * ScanHistoryTable — the one scan-history layout, shared by the roster
 * expansion tab and the asset/move detail pages so it cannot fork.
 * Real table (house .activity-changes styling): one field per column,
 * '—' per blank cell. Lazy: fetches once per assetId on mount.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { listAssetScans, type AssetScanRow } from '../../lib/api';

export default function ScanHistoryTable({ assetId, limit, capHint }: {
  assetId: string; limit?: number; capHint?: number;
}) {
  const [scans, setScans] = useState<AssetScanRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setScans(null);
    setError(false);
    void listAssetScans(assetId, limit)
      .then(setScans)
      .catch(() => setError(true));
  }, [assetId, limit]);

  if (error) return <p className="page-hint">Could not load scan history.</p>;
  if (scans === null) return <p className="page-hint">Loading…</p>;
  if (scans.length === 0) {
    return <p className="page-hint">No scans recorded for this asset.</p>;
  }
  return (
    <>
      <table className="activity-changes scan-history">
        <thead>
          <tr>
            <th>Scanned</th><th>Method</th><th>Device</th>
            <th>Operator</th><th>Site</th><th>Location</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((s) => (
            <tr key={s.id}>
              <td className="mono scan-when">
                {new Date(s.scanned_at).toLocaleString()}
              </td>
              <td>
                <span className="chip custom"
                      style={{ '--chip': s.scan_type_color } as CSSProperties}>
                  <span className="dot" />{s.scan_type_label}
                </span>
              </td>
              <td className="mono">{s.device_id || '—'}</td>
              <td>{s.operator_name ?? '—'}</td>
              <td>{s.site_name ?? '—'}</td>
              <td>{s.location_detail || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {capHint !== undefined && scans.length >= capHint && (
        <p className="page-hint">Latest {capHint} scans shown.</p>
      )}
    </>
  );
}
