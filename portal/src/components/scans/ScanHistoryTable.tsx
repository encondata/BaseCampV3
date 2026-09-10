/**
 * ScanHistoryTable — the one scan-history layout, shared by the roster
 * expansion tab and the asset/move detail pages so it cannot fork.
 * Renders through <DataTable> (house list-typography tokens): one field
 * per column, '—' per blank cell. Lazy: fetches once per assetId on mount.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import DataTable from '../DataTable';
import { listAssetScans, type AssetScanRow } from '../../lib/api';
import { statusChip } from '../../lib/chips';

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
      <DataTable
        ariaLabel="Scan history"
        className="scan-history"
        columns={[
          { key: 'status', label: 'Status' },
          { key: 'scanned', label: 'Scanned', mono: true, width: '160px' },
          { key: 'method', label: 'Method' },
          { key: 'device', label: 'Device', mono: true },
          { key: 'operator', label: 'Operator' },
          { key: 'site', label: 'Site' },
          { key: 'location', label: 'Location' },
        ]}
        rows={scans.map((s) => ({
          key: s.id,
          cells: [
            statusChip(s.status_label, s.status_color) ?? '—',
            <span className="scan-when">{new Date(s.scanned_at).toLocaleString()}</span>,
            <span className="chip custom"
                  style={{ '--chip': s.scan_type_color } as CSSProperties}>
              <span className="dot" />{s.scan_type_label}
            </span>,
            s.device_id || '—',
            s.operator_name ?? '—',
            s.site_name ?? '—',
            s.location_detail || '—',
          ],
        }))}
      />
      {capHint !== undefined && scans.length >= capHint && (
        <p className="page-hint">Latest {capHint} scans shown.</p>
      )}
    </>
  );
}
