/**
 * AssetMoveHistory — every move roster this asset has appeared on, one line
 * each. Deliberately compact: rack, RU, disposition and verification live on
 * the move-row page each line links to.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../DataTable';
import { listAssetMoves, type AssetMoveRow } from '../../lib/api';
import { statusChip } from '../../lib/chips';
import { longDateOf } from '../../lib/format';
import { parseApiDay } from '../../lib/timeline';

/** scheduled_* are date-only at midnight UTC: parseApiDay keeps the day from
 *  sliding backwards for anyone west of UTC, which plain longDate does not. */
function scheduled(row: AssetMoveRow): string {
  if (!row.scheduled_start && !row.scheduled_end) return '—';
  const start = row.scheduled_start ? longDateOf(parseApiDay(row.scheduled_start)) : '—';
  if (!row.scheduled_end) return start;
  const end = longDateOf(parseApiDay(row.scheduled_end));
  return start === end ? start : `${start} – ${end}`;
}

export default function AssetMoveHistory({ assetId }: { assetId: string }) {
  const [rows, setRows] = useState<AssetMoveRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRows(await listAssetMoves(assetId));
    } catch {
      setFailed(true);
    }
  }, [assetId]);

  useEffect(() => { void load(); }, [load]);

  if (failed) {
    return (
      <div className="dir-empty">
        <b>Could not load move history.</b>
        <button type="button" className="mini-btn" style={{ marginTop: 8 }}
                onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (rows === null) {
    return <p className="set-note" style={{ padding: 0 }}>Loading…</p>;
  }

  return (
    <DataTable ariaLabel="Move history"
      emptyText="This asset has not been on a move."
      columns={[
        { key: 'move', label: 'Move' },
        { key: 'status', label: 'Status' },
        { key: 'asset', label: 'Asset status' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'open', label: '' },
      ]}
      rows={rows.map((r) => ({
        key: r.row_id,
        cells: [
          <Link key="move" to={`/initiatives/${r.initiative_id}`}>{r.initiative_name}</Link>,
          statusChip(r.initiative_status_label, r.initiative_status_color),
          statusChip(r.asset_status_label, r.asset_status_color),
          scheduled(r),
          <Link key="open" className="mini-btn" to={`/initiatives/${r.initiative_id}/assets/${r.row_id}`}>
            Open move row
          </Link>,
        ],
      }))} />
  );
}
