/** The test set as this place sees it: one line per expected result of this
 *  place (an asset with none gets one line of dashes), each with the result
 *  the selected version gives today. Add, Edit and Delete work on the whole
 *  test asset. */

import { useId } from 'react';

import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import { RowActionsMenu } from '../hardware/RowActionsMenu';
import type { MatchingPlace, MatchingTestAsset, MatchingTestRowResult } from '../../lib/api';
import { ACTIONS_TRACK } from '../../lib/listTools';
import { EXPECTED_LABELS, FIELDS } from '../../lib/matchingRules';

export const MAX_TEST_ASSETS = 10;
const MIN_TEST_ASSETS = 5;

const COLUMNS: DataTableColumn[] = [
  { key: 'asset_tag', label: 'Asset tag', width: '96px', mono: true },
  { key: 'name', label: 'Name' },
  { key: 'value', label: 'Value tried', mono: true },
  { key: 'expected', label: 'Should find' },
  { key: 'result', label: 'Result' },
  { key: 'actions', label: '', width: ACTIONS_TRACK, align: 'right' },
];

function resultText(r: MatchingTestRowResult): string {
  if (r.passed) return 'Pass';
  if (r.outcome === 'found') {
    const field = FIELDS.find((f) => f.key === r.found_field)?.label ?? r.found_field ?? '';
    return `Fail: found by ${field} on ${r.found_asset_tag ?? '—'}`;
  }
  return r.outcome === 'stopped' ? 'Fail: stopped' : 'Fail: not found';
}

export default function TestAssetsPanel({
  place, assets, results, onAdd, onEdit, onDelete, loading = false, error = '',
}: {
  place: MatchingPlace;
  assets: MatchingTestAsset[];
  results: MatchingTestRowResult[];
  onAdd: () => void;
  onEdit: (a: MatchingTestAsset) => void;
  onDelete: (a: MatchingTestAsset) => void;
  /** The list hasn't come back yet. */
  loading?: boolean;
  /** The list couldn't be loaded. */
  error?: string;
}) {
  const titleId = useId();
  // Until the real list is here, an empty one says nothing about the test set.
  const known = !loading && !error;
  const full = assets.length >= MAX_TEST_ASSETS;
  const byRow = new Map(results.map((r) => [r.row_id, r]));

  const rows: DataTableRow[] = [...assets]
    .sort((a, b) => a.asset_tag - b.asset_tag)
    .flatMap((a) => {
      const actions = (
        <div key="actions" className="mr-actions">
          <RowActionsMenu actions={[
            { key: 'edit', label: 'Edit', onSelect: () => onEdit(a) },
            { key: 'delete', label: 'Delete', destructive: true, onSelect: () => onDelete(a) },
          ]} />
        </div>
      );
      const tag = String(a.asset_tag);
      const name = <span key="name" className="cell-top cell-line">{a.name}</span>;
      const mine = a.rows.filter((r) => r.place === place);
      if (mine.length === 0) {
        return [{ key: a.id, cells: [tag, name, '—', '—', '—', actions] }];
      }
      return mine.map((r) => {
        const res = byRow.get(r.id);
        return {
          key: r.id,
          cells: [
            tag,
            name,
            r.value,
            EXPECTED_LABELS.find((e) => e.key === r.expected)?.label ?? r.expected,
            res ? <span key="result" className={res.passed ? 'mr-pass' : 'mr-fail'}>{resultText(res)}</span> : '—',
            actions,
          ],
        };
      });
    });

  return (
    <section className="mr-panel mr-scroll" aria-labelledby={titleId}>
      <div className="mr-panel-bar">
        <h2 className="mr-panel-title" id={titleId}>Test assets</h2>
        <button type="button" className="btn-solid" disabled={!known || full} onClick={onAdd}>Add test asset</button>
      </div>
      {error && <p className="pf-error" role="alert">{error}</p>}
      {!error && loading && <p className="page-hint">Loading…</p>}
      {known && full && <p className="page-hint">The test set holds at most 10 assets.</p>}
      {known && assets.length < MIN_TEST_ASSETS && (
        <p className="page-hint">The test set should have 5 to 10 assets.</p>
      )}
      {known && <DataTable ariaLabel="Test assets" columns={COLUMNS} rows={rows} />}
    </section>
  );
}
