/**
 * BulkApplySummary — what a bulk apply actually did, one row per site, with
 * a CSV download so the run can be attached to a ticket. Server truth: it
 * renders the commit response, never the pre-apply preview.
 */
import { Link } from 'react-router-dom';

import type { BulkCommitResult } from '../../lib/api';
import { exportCsv } from '../../lib/listTools';
import DataTable from '../DataTable';

const RESULT_LABEL = { created: 'Added', updated: 'Updated', unchanged: 'No change' } as const;

export function changesText(diff: BulkCommitResult['rows'][number]['diff']): string {
  if (!diff) return '';
  return Object.entries(diff).map(([field, change]) => {
    if (field === 'clients') {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return `clients: ${[...add, ...remove].join(', ')}`;
    }
    const from = change.old === null || change.old === undefined ? '—' : String(change.old);
    return `${field}: ${from} → ${String(change.new)}`;
  }).join('; ');
}

export default function BulkApplySummary({ result }: { result: BulkCommitResult }) {
  const download = () => exportCsv('sites-bulk-summary', [
    ['Row', (r) => String(r.row)],
    ['Site', (r) => r.name],
    ['Result', (r) => RESULT_LABEL[r.action]],
    ['Changes', (r) => changesText(r.diff)],
  ], result.rows);

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {result.created} added · {result.updated} updated · {result.unchanged} unchanged</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
        <Link className="mini-btn" to="/sites">Open Sites</Link>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '64px', mono: true },
          { key: 'site', label: 'Site' },
          { key: 'result', label: 'Result' },
          { key: 'changes', label: 'Changes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${r.action === 'created' ? 'create' : r.action === 'updated' ? 'update' : 'unchanged'}`,
          cells: [
            r.row,
            <Link key="site" to={`/sites?open=${r.site_id}`}>{r.name}</Link>,
            RESULT_LABEL[r.action],
            changesText(r.diff) || '—',
          ],
        }))}
      />
    </div>
  );
}
