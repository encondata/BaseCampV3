/** What a MacroPoint apply did, one row per email (server truth: renders
 *  the apply response). Same layout as BulkApplySummary, whose fixed
 *  created/updated/skipped/unchanged results have no duplicate or error. */
import type { MacroPointApplyResult, MacroPointResultRow } from '../../lib/api';
import { exportCsv } from '../../lib/listTools';
import { noteText, reasonText } from '../../lib/macropoint';
import DataTable from '../DataTable';

const RESULT_LABEL = {
  added: 'Added', duplicate: 'Already recorded', skipped: 'Skipped', error: 'Error',
} as const;
const ROW_CLASS = {
  added: 'create', duplicate: 'unchanged', skipped: 'skipped', error: 'error',
} as const;

const when = (r: MacroPointResultRow) => (r.recorded_at ? new Date(r.recorded_at).toLocaleString() : '');
const notes = (r: MacroPointResultRow) =>
  [r.status_change ?? '', r.reason ? reasonText(r.reason) : '', noteText(r.note)]
    .filter(Boolean).join(' · ');

export default function MacroPointSummary({ result }: { result: MacroPointApplyResult }) {
  const download = () => exportCsv<MacroPointResultRow>('macropoint-update-summary', [
    ['Row', (r) => String(r.row)],
    ['Source', (r) => r.source],
    ['Load', (r) => r.id_number ?? ''],
    ['Truck', (r) => r.truck_name ?? ''],
    ['Time', when],
    ['Update', (r) => r.detail],
    ['Result', (r) => RESULT_LABEL[r.result]],
    ['Notes', notes],
  ], result.rows);

  const counts = [
    `${result.added} added`,
    `${result.duplicates} already recorded`,
    `${result.skipped} skipped`,
    `${result.errors} ${result.errors === 1 ? 'error' : 'errors'}`,
    `${result.status_changes} status ${result.status_changes === 1 ? 'change' : 'changes'}`,
  ].join(' · ');

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {counts}</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '56px', mono: true },
          { key: 'source', label: 'Source' },
          { key: 'load', label: 'Load' },
          { key: 'truck', label: 'Truck' },
          { key: 'when', label: 'Time', mono: true },
          { key: 'update', label: 'Update' },
          { key: 'result', label: 'Result' },
          { key: 'notes', label: 'Notes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${ROW_CLASS[r.result]}`,
          cells: [r.row, r.source, r.id_number ?? '—', r.truck_name ?? '—', when(r) || '—',
                  r.detail || '—', RESULT_LABEL[r.result], notes(r) || '—'],
        }))}
      />
    </div>
  );
}
