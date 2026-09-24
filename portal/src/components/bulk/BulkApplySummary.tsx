/**
 * BulkApplySummary — what a bulk apply actually did, one row per record,
 * with a CSV download so the run can be attached to a ticket. Server truth:
 * it renders the commit response, never the pre-apply preview. Shared by
 * every Bulk Actions tool; the caller names the entity and builds links.
 * Optional extras for tools with big results (assets): `pageSize` lists that
 * many rows at a time behind "Show N more" (the CSV still has every row),
 * `extraColumn` adds one column after the name (table and CSV), and `note`
 * adds one muted line under the counts.
 */
import { useEffect, useState } from 'react';
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

/** One extra column after the name, in the table and the CSV. */
export interface BulkSummaryColumn<R extends BulkSummaryRow> {
  label: string;
  /** The cell text; '' renders as an em dash in the table. */
  value: (row: R) => string;
  mono?: boolean;
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
  /** List this many rows at a time behind "Show N more"; unset lists every row. */
  pageSize?: number;
  extraColumn?: BulkSummaryColumn<R>;
  /** One muted line under the counts. */
  note?: string;
}

export default function BulkApplySummary<R extends BulkSummaryRow>({
  result, entityLabel, linkFor, filename, openTo, openLabel, pageSize, extraColumn, note,
}: Props<R>) {
  const [shown, setShown] = useState(pageSize ?? Infinity);
  useEffect(() => setShown(pageSize ?? Infinity), [result, pageSize]);

  const download = () => exportCsv<R>(filename, [
    ['Row', (r) => String(r.row)],
    [entityLabel, (r) => r.name ?? '—'],
    ...(extraColumn ? [[extraColumn.label, extraColumn.value] as [string, (r: R) => string]] : []),
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
      {note && <p className="set-note">{note}</p>}
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '64px', mono: true },
          { key: 'name', label: entityLabel },
          ...(extraColumn ? [{ key: 'extra', label: extraColumn.label, mono: extraColumn.mono }] : []),
          { key: 'result', label: 'Result' },
          { key: 'changes', label: 'Changes' },
        ]}
        rows={result.rows.slice(0, shown).map((r) => ({
          key: String(r.row),
          className: `bulk-row-${ROW_CLASS[r.action]}`,
          cells: [
            r.row,
            <Link key="name" to={linkFor(r)}>{r.name ?? '—'}</Link>,
            ...(extraColumn ? [extraColumn.value(r) || '—'] : []),
            RESULT_LABEL[r.action],
            changesText(r.diff) || '—',
          ],
        }))}
      />
      {pageSize !== undefined && result.rows.length > shown && (
        <div className="bulk-actions">
          <button className="mini-btn" type="button" onClick={() => setShown((s) => s + pageSize)}>
            {`Show ${Math.min(pageSize, result.rows.length - shown)} more`}
          </button>
        </div>
      )}
    </div>
  );
}
