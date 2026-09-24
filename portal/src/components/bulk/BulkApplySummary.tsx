/**
 * BulkApplySummary — what a bulk apply actually did, one row per record,
 * with a CSV download so the run can be attached to a ticket. Server truth:
 * it renders the commit response, never the pre-apply preview. Shared by
 * every Bulk Actions tool; the caller names the entity and builds links.
 */
import { Link } from 'react-router-dom';

import { exportCsv } from '../../lib/listTools';
import DataTable from '../DataTable';

export type BulkDiff = Record<
  string,
  { old?: unknown; new?: unknown; add?: string[]; remove?: string[] }
>;

export interface BulkSummaryRow {
  row: number;
  /** null when the imported row carried no name — rendered as an em dash. */
  name: string | null;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  diff: BulkDiff | null;
}

export interface BulkSummaryResult<R extends BulkSummaryRow> {
  /** Absent for tools that only update existing records (assets). */
  created?: number;
  updated: number;
  unchanged: number;
  /** Present for tools with per-row skip (workers); absent for sites. */
  skipped?: number;
  rows: R[];
}

const RESULT_LABEL = {
  created: 'Added', updated: 'Updated', skipped: 'Skipped', unchanged: 'No change',
} as const;
const ROW_CLASS = {
  created: 'create', updated: 'update', skipped: 'skipped', unchanged: 'unchanged',
} as const;

export function changesText(diff: BulkDiff | null): string {
  if (!diff) return '';
  return Object.entries(diff).map(([field, change]) => {
    if (change.add !== undefined || change.remove !== undefined) {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return `${field}: ${[...add, ...remove].join(', ')}`;
    }
    const from = change.old === null || change.old === undefined ? '—' : String(change.old);
    return `${field}: ${from} → ${String(change.new)}`;
  }).join('; ');
}

interface Props<R extends BulkSummaryRow> {
  result: BulkSummaryResult<R>;
  /** Column header and CSV header for the record name ("Site", "Worker"). */
  entityLabel: string;
  linkFor: (row: R) => string;
  /** exportCsv base name, e.g. "sites-bulk-summary". */
  filename: string;
  openTo: string;
  openLabel: string;
}

export default function BulkApplySummary<R extends BulkSummaryRow>({
  result, entityLabel, linkFor, filename, openTo, openLabel,
}: Props<R>) {
  const download = () => exportCsv<R>(filename, [
    ['Row', (r) => String(r.row)],
    [entityLabel, (r) => r.name ?? '—'],
    ['Result', (r) => RESULT_LABEL[r.action]],
    ['Changes', (r) => changesText(r.diff)],
  ], result.rows);

  const counts = [
    ...(result.created !== undefined ? [`${result.created} added`] : []),
    `${result.updated} updated`,
    ...(result.skipped !== undefined ? [`${result.skipped} skipped`] : []),
    `${result.unchanged} unchanged`,
  ].join(' · ');

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {counts}</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
        <Link className="mini-btn" to={openTo}>{openLabel}</Link>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '64px', mono: true },
          { key: 'name', label: entityLabel },
          { key: 'result', label: 'Result' },
          { key: 'changes', label: 'Changes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${ROW_CLASS[r.action]}`,
          cells: [
            r.row,
            <Link key="name" to={linkFor(r)}>{r.name ?? '—'}</Link>,
            RESULT_LABEL[r.action],
            changesText(r.diff) || '—',
          ],
        }))}
      />
    </div>
  );
}
