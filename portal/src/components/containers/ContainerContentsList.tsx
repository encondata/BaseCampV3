/**
 * ContainerContentsList — the assets packed in a container, as the standard
 * house list: search + count, sortable / filterable headers, Columns menu,
 * CSV export, column floors. Cells are the Assets list's own (AssetCell), so
 * an asset reads the same here as there; a row opens the asset's page.
 * A row whose asset the viewer cannot open (`asset` null) renders from the
 * flat fields the contents endpoint always returns and is not clickable.
 * Lives in the Containers row expansion.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import { listContainerAssets, type ContainerAssetRow } from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import {
  CONTENTS_ALL_KEYS, CONTENTS_COLUMNS, CONTENTS_CSV_COLUMNS, CONTENTS_DEFAULT_VISIBLE,
  contentsCellText, contentsSearchText, contentsSortValue, packedDate,
} from '../../lib/containerContents';
import {
  applyColumnOrder, ColHead, ColumnsButton, ExportButton, exportCsv, listGridStyle,
  listScale, moveKey, titleFor, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
} from '../../lib/listTools';
import { naturalCompare } from '../../lib/sites';
import { AssetCell } from '../assets/assetColumns';
import '../../styles/directory.css';
import '../../styles/containers.css';

/** One cell of a row. With the asset record it is the shared read-only cell
 *  (plus the Packed column); without it, the flat fields stand in. */
function ContentsCell({ row, colKey }: { row: ContainerAssetRow; colKey: string }) {
  if (colKey === 'packed') {
    const by = row.added_by_name;
    return (
      <div className="cc-packed" title={by ? `Packed by ${by}` : undefined}>
        <span className="mono cell-line">{packedDate(row)}</span>
        {by && <span className="cell-sub cell-line">{by}</span>}
      </div>
    );
  }
  if (row.asset) return <AssetCell asset={row.asset} colKey={colKey} />;
  const text = contentsCellText(row, colKey);
  switch (colKey) {
    case 'serial':
    case 'asset_id':
    case 'rfid':
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    case 'status':
      return (
        <div className="chips">
          <span className="chip custom" style={{ '--chip': row.status_color } as CSSProperties}>
            <span className="dot" />{row.status_label}
          </span>
        </div>
      );
    default:
      return <span className="cell-top cell-line" title={titleFor(text)}>{text || '—'}</span>;
  }
}

export default function ContainerContentsList({ containerId }: { containerId: string }) {
  const navigate = useNavigate();
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);

  const [rows, setRows] = useState<ContainerAssetRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'container-contents',
    { visible: CONTENTS_DEFAULT_VISIBLE, sortKey: 'asset_id', sortDir: 1 },
    CONTENTS_ALL_KEYS,
  );

  useEffect(() => {
    let live = true;
    setRows(null);
    setFailed(false);
    listContainerAssets(containerId)
      .then((r) => { if (live) setRows(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [containerId]);

  const haystack = useSearchHaystacks(rows, contentsSearchText);
  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => passesColumnFilters(r, filters, contentsCellText)
        && (!q || haystack(r).includes(q)))
      .sort((a, b) => naturalCompare(
        contentsSortValue(a, sortKey), contentsSortValue(b, sortKey)) * sortDir);
  }, [rows, filters, query, sortKey, sortDir, haystack]);

  const orderedCols = applyColumnOrder(CONTENTS_COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle(shownCols, [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  const exportRows = useCallback(
    () => exportCsv('container-contents', CONTENTS_CSV_COLUMNS, visible), [visible]);

  if (failed) return <p className="page-hint">Failed to load contents.</p>;
  if (rows === null) return <p className="page-hint">Loading…</p>;
  if (rows.length === 0) return <p className="page-hint">No assets in this container.</p>;

  return (
    <div className="cc-contents">
      <div className="dir-toolbar cc-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter contents…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {rows.length} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={exportRows} />
        </div>
      </div>

      <div className="dir-list cc-list list-scroll">
        <div className="list-head" style={rowStyle}>
          {shownCols.map((c) => (
            <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                     onToggleSort={() => toggleSort(c.key)}
                     className={headerDrag.dropClass(c.key)}
                     dragProps={headerDrag.dragProps(c.key)}>
              <ColumnMenu colKey={c.key} label={c.label}
                          allRows={rows} filters={filters} text={contentsCellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null}
                          onSort={(dir) => setSort(c.key, dir)} />
            </ColHead>
          ))}
        </div>

        {visible.length === 0 && (
          <div className="dir-empty">
            <b>No matches</b>Try a different search or filter.
            <EmptyClearFilters filters={filters} onClear={clearFilters} />
          </div>
        )}

        {visible.map((r) => {
          const assetId = r.asset?.id;
          return (
            <div key={r.asset_id} className={`dir-row${assetId ? '' : ' cc-static'}`}
                 style={{ minWidth: rowStyle.minWidth }}>
              <div className="row-main" style={rowStyle}
                   onClick={assetId ? () => navigate(`/assets/${assetId}`) : undefined}>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}><ContentsCell row={r} colKey={c.key} /></div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
