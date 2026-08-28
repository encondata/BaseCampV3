/**
 * SiteSurveyList — the curated site survey answers (Task 5): a full
 * registry-ordered standard list (filter/sort/columns/export), one row per
 * registry field whether answered or not. Default sort preserves
 * questionnaire order (the API already returns rows registry-ordered; we
 * capture each field's array position at load and sort on that).
 *
 * Value editing is always-on (when the actor can change sites), not gated
 * behind a god-mode toggle: this reuses lib/godEdit's `GodCell` directly,
 * per row, with a `GodField` shaped from the row's `kind` (bool/select ->
 * combo, text/textarea/int -> text) and a custom patch that PUTs a value
 * or, for a cleared value, DELETEs and synthesizes the cleared row locally
 * (the DELETE endpoint returns 204, no body). `GodCell` itself has no
 * dependency on god-mode state — only `useGodEdit`/`GodEditToggle` do — so
 * rendering it unconditionally, driven by our own `canChange` instead of a
 * god-editing toggle, is a straight reuse of the component, not a fight
 * with its contract. No archived column, no row expansion, no god toggle:
 * every row is a registry field, not a deletable record.
 */
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, clearSiteSurveyValue, listSiteSurvey, putSiteSurveyValue,
  type SiteSurveyRow,
} from '../../lib/api';
import {
  SITE_SURVEY_ERRORS, filledCount, surveyCellText, surveySearchText, surveyValueText,
} from '../../lib/siteSurvey';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import { GodCell, type GodField } from '../../lib/godEdit';
import { naturalCompare } from '../../lib/sites';
import {
  applyColumnOrder, ColumnsButton, ExportButton, exportCsv, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import { VirtualRows } from '../../lib/virtualRows';

const COLUMNS: ColumnDef[] = [
  { key: 'group', label: 'Group', width: '1fr', default: true },
  { key: 'value', label: 'Value', width: '1.4fr', default: true },
  { key: 'updated_by', label: 'Updated by', width: '1fr', default: true },
  { key: 'updated', label: 'Updated', width: '1fr', default: false },
];
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'field']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** GodField descriptor for one row, shaped from its registry `kind`.
 *  bool/select answer through a ComboBox (`kind: 'combo'`) so clearing is
 *  a click on the built-in clear button; text/textarea/int all edit as a
 *  plain text box (`kind: 'text'`) — int values are parsed to a real
 *  number in `toPatch` since the API 422s a stringified int. */
function godFieldForRow(row: SiteSurveyRow): GodField<SiteSurveyRow> {
  if (row.kind === 'bool') {
    return {
      column: 'value', field: 'value', kind: 'combo',
      fromRow: (r) => (r.value === null ? '' : (r.value ? 'true' : 'false')),
      toPatch: (raw) => (raw === '' ? null : raw === 'true'),
      options: () => [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    };
  }
  if (row.kind === 'select') {
    return {
      column: 'value', field: 'value', kind: 'combo',
      fromRow: (r) => (r.value === null ? '' : String(r.value)),
      toPatch: (raw) => (raw === '' ? null : raw),
      options: () => row.options.map((o) => ({ value: o, label: o.charAt(0).toUpperCase() + o.slice(1) })),
    };
  }
  return {
    column: 'value', field: 'value', kind: 'text',
    fromRow: (r) => (r.value === null ? '' : String(r.value)),
    toPatch: (raw) => {
      const v = raw.trim();
      if (v === '') return null;
      if (row.kind === 'int') {
        const n = Number(v);
        if (!Number.isInteger(n)) throw new Error('not_a_number');
        return n;
      }
      return v;
    },
  };
}

function sortValueFor(row: SiteSurveyRow, key: string, fieldOrder: Map<string, number>): string {
  switch (key) {
    case 'field': return String(fieldOrder.get(row.field_key) ?? 0).padStart(4, '0');
    case 'group': return row.group_label.toLowerCase();
    case 'value': return surveyValueText(row).toLowerCase();
    case 'updated_by': return (row.updated_by_name ?? '').toLowerCase();
    case 'updated': return row.updated_at ?? '';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (r: SiteSurveyRow) => string][] = [
  ['Field key', (r) => r.field_key],
  ['Label', (r) => r.label],
  ['Group', (r) => r.group_label],
  ['Value', (r) => surveyValueText(r)],
  ['Updated by', (r) => r.updated_by_name ?? ''],
  ['Updated at', (r) => r.updated_at ?? ''],
];

export default function SiteSurveyList({ siteId, onCount }: {
  siteId: string;
  onCount?: (info: { filled: number; total: number } | null) => void;
}) {
  const { can } = useAuth();
  const canChange = can('sites', 'change');

  const [rows, setRows] = useState<SiteSurveyRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'site_survey', { visible: DEFAULT_VISIBLE, sortKey: 'field', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const data = await listSiteSurvey(siteId);
      setRows(data);
      setError('');
      onCount?.(filledCount(data));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view this site.'
        : 'Failed to load survey data.');
      onCount?.(null);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // Registry position at load, keyed by field — the default sort's join
  // to questionnaire order. replaceRow (below) only ever swaps a row in
  // place, never reorders the array, so this stays valid across edits.
  const fieldOrder = useMemo(() => {
    const m = new Map<string, number>();
    rows?.forEach((r, i) => m.set(r.field_key, i));
    return m;
  }, [rows]);

  const replaceRow = (updated: SiteSurveyRow) => {
    setRows((xs) => {
      const next = xs?.map((x) => (x.field_key === updated.field_key ? updated : x)) ?? xs;
      if (next) onCount?.(filledCount(next));
      return next;
    });
  };

  const haystack = useSearchHaystacks(rows, surveySearchText);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (!passesColumnFilters(r, filters, surveyCellText)) return false;
      if (!q) return true;
      return haystack(r).includes(q);
    });
    return filtered.sort((a, b) => naturalCompare(
      sortValueFor(a, sortKey, fieldOrder), sortValueFor(b, sortKey, fieldOrder),
    ) * sortDir);
  }, [rows, filters, query, sortKey, sortDir, haystack, fieldOrder]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2fr ${shownCols.map((c) => c.width).join(' ')}` };

  // Closes over `row` fresh each render (cellFor is called with the live
  // row from `visible`), so the synthesized cleared-row fallback below
  // always starts from up-to-date label/group/kind/options metadata —
  // no separate lookup against `rows` state needed.
  const patchValueFor = (row: SiteSurveyRow) =>
    async (fieldKey: string, body: Record<string, unknown>): Promise<SiteSurveyRow> => {
      const value = body.value as boolean | number | string | null;
      if (value === null) {
        await clearSiteSurveyValue(siteId, fieldKey);
        return {
          ...row, value: null, raw_id: null,
          updated_by: null, updated_by_name: null, updated_at: null,
        };
      }
      return putSiteSurveyValue(siteId, fieldKey, value);
    };

  const cellFor = (row: SiteSurveyRow, key: string) => {
    if (key === 'value') {
      if (!canChange) return <span className="cell-top">{surveyValueText(row)}</span>;
      return (
        <GodCell row={row} gf={godFieldForRow(row)} patch={patchValueFor(row)}
                 onRowSaved={replaceRow} errorMap={SITE_SURVEY_ERRORS}
                 idOf={(r) => r.field_key} />
      );
    }
    switch (key) {
      case 'group': return <span className="cell-top">{row.group_label}</span>;
      case 'updated_by': return <span className="cell-top">{row.updated_by_name ?? '—'}</span>;
      case 'updated':
        return (
          <span className="cell-top">
            {row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}
          </span>
        );
      default: return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter survey…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {rows?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('site-survey', CSV_COLUMNS, visible)} />
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load survey</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('field')}>
                Field {caret('field')}
              </button>
              <ColumnMenu colKey="field" label="Field"
                          allRows={rows ?? []} filters={filters}
                          text={surveyCellText}
                          filter={filters.field} onFilter={setFilter}
                          sortDir={sortKey === 'field' ? sortDir : null}
                          onSort={(dir) => setSort('field', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={rows ?? []} filters={filters}
                            text={surveyCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
          </div>

          {rows && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(row, vp) => (
              <div key={row.field_key} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  <div className="cell cell-primary">
                    <div className="pn"><b>{row.label}</b><span>{row.group_label}</span></div>
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(row, col.key)}</div>
                  ))}
                </div>
              </div>
            )} />
        </div>
      )}
    </>
  );
}
