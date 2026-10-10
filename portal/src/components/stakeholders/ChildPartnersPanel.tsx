/**
 * ChildPartnersPanel — the "Child partners" section of a partner's Full
 * Details page: the partners placed directly under this one (subsidiaries,
 * branches), as a standard house list (search, column menu, export,
 * floors) inside an .init-panel.
 *
 * Staff (`canEdit`) also get "Add child" (a small modal with a ComboBox of
 * partners that have no parent and aren't this partner or one of its
 * ancestors) and a per-row "Remove" that clears the child's parent. A
 * partner-scoped viewer sees only the list, and only when it has rows — the
 * hierarchy is staff-managed. The API enforces all of it (staff-only
 * writes, cycle checks, scope); this component just doesn't offer a choice
 * it would refuse.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import {
  ApiError, listPartnerChildren, listPartnerItems, setPartnerParent, type StatusValue,
} from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import {
  ACTIONS_TRACK, applyColumnOrder, ColHead, ColumnsButton, ExportButton, exportCsv,
  listGridStyle, listScale, moveKey, titleFor, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import {
  ORG_ERRORS, orgCellText, partnerAncestorIds, partnerTypeColor, partnerTypeLabel,
  STATUS_META, effectiveStatus, type OrgItem,
} from '../../lib/orgs';
import { naturalCompare } from '../../lib/sites';
import { VirtualRows } from '../../lib/virtualRows';
import { useAuth } from '../../auth/AuthContext';
import ComboBox from '../ComboBox';
import { RowActionsMenu } from '../hardware/RowActionsMenu';
import '../../styles/reports.css';   // .rgm-* — the roomy modal header
import '../../styles/directory.css';
import '../../styles/initiatives.css';

// Sits inside an .init-panel. Fit: default columns + trailing ≤
// LIST_FIT.initPanel (see StakeholderDetail's INIT_COLUMNS).
const CHILD_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.6fr', default: true, min: 140 },
  { key: 'type', label: 'Types', width: '1.2fr', default: true },
  { key: 'service_region', label: 'Region', width: '1fr', default: true },
  { key: 'status', label: 'Status', width: '1fr', default: true },
];
const CHILD_ALL_KEYS = new Set(CHILD_COLUMNS.map((c) => c.key));
const CHILD_DEFAULT_VISIBLE = new Set(CHILD_COLUMNS.map((c) => c.key));

const errorText = (e: unknown) =>
  e instanceof ApiError && ORG_ERRORS[e.code] ? ORG_ERRORS[e.code] : 'Could not save — try again.';

export default function ChildPartnersPanel({ partner, typeVocab, canEdit }: {
  partner: OrgItem;
  typeVocab: Map<string, StatusValue>;
  canEdit: boolean;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [children, setChildren] = useState<OrgItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(() => listPartnerChildren(partner.id)
    .then(setChildren)
    .catch(() => setChildren((prev) => prev ?? [])), [partner.id]);

  useEffect(() => {
    setChildren(null);
    void load();
  }, [load]);

  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(
    'stakeholder_children',
    { visible: CHILD_DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 },
    CHILD_ALL_KEYS,
  );

  const cellText = useCallback((o: OrgItem, key: string) =>
    (key === 'name' ? o.name : orgCellText(o, key, typeVocab)), [typeVocab]);
  const orderedCols = applyColumnOrder(CHILD_COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const haystackText = useCallback(
    (o: OrgItem) => CHILD_COLUMNS.map((c) => cellText(o, c.key)).join(' ').toLowerCase(),
    [cellText]);
  const haystack = useSearchHaystacks(children, haystackText);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (children ?? [])
      .filter((o) => passesColumnFilters(o, filters, cellText)
        && (!q || haystack(o).includes(q)))
      .sort((a, b) => naturalCompare(cellText(a, sortKey), cellText(b, sortKey)) * sortDir);
  }, [children, filters, query, sortKey, sortDir, haystack, cellText]);

  const csvColumns = useMemo<[string, (o: OrgItem) => string][]>(
    () => CHILD_COLUMNS.map((c) => [c.label, (o: OrgItem) => cellText(o, c.key)]),
    [cellText]);

  const grid = listGridStyle(shownCols, canEdit ? [ACTIONS_TRACK] : [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const remove = async (child: OrgItem) => {
    if (!window.confirm(`Remove ${child.name} from ${partner.name}? It stays a partner, with no parent.`)) return;
    setError('');
    try {
      await setPartnerParent(child.id, null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const cellFor = (o: OrgItem, key: string) => {
    switch (key) {
      case 'name':
        return (
          <Link className="cell-top cell-line" to={`/stakeholders/partners/${o.id}`}
                title={titleFor(o.name)}>{o.name}</Link>
        );
      case 'type':
        return (
          <div className="chips">
            {o.partner_types.length === 0 && <span className="chip tag">—</span>}
            {o.partner_types.map((t) => (
              <span key={t} className="chip custom"
                    style={{ '--chip': partnerTypeColor(t, typeVocab) } as CSSProperties}>
                <span className="dot" />{partnerTypeLabel(t, typeVocab)}
              </span>
            ))}
          </div>
        );
      case 'service_region': {
        const text = o.service_region || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'status': {
        const s = STATUS_META[effectiveStatus(o)];
        return <span className={`chip ${s.cls}`}><span className="dot" />{s.label}</span>;
      }
      default: return null;
    }
  };

  // The hierarchy is staff-managed: a viewer who can't edit sees the panel
  // only when there is something to read.
  if (!canEdit && (children === null || children.length === 0)) return null;

  return (
    <div className="init-panel" style={{ marginTop: 18 }}>
      <div className="idet-panel-head">
        <p className="eyebrow-sm">
          Child partners
          {children !== null && <span className="badge-count">{children.length}</span>}
        </p>
        {canEdit && (
          <button type="button" className="mini-btn accent" onClick={() => setAdding(true)}>
            Add child
          </button>
        )}
      </div>
      {error && <p className="pf-error">{error}</p>}
      {children === null && <p className="page-hint">Loading…</p>}
      {children !== null && children.length === 0 && (
        <p className="page-hint">No child partners.</p>
      )}
      {children !== null && children.length > 0 && (
        <>
          <div className="dir-toolbar idet-people-toolbar">
            <div className="toolbar-right">
              <div className="dir-search" style={{ marginLeft: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input placeholder="Filter child partners…" value={query}
                       onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span className="result-count">{visible.length} of {children.length} shown</span>
              <FilterSummaryChip filters={filters} onClear={clearFilters} />
              <ColumnsButton columns={orderedCols} visible={visibleCols}
                             onChange={setVisibleCols} onReorder={setColOrder} />
              <ExportButton onExport={() => exportCsv('child-partners', csvColumns, visible)} />
            </div>
          </div>

          <div className="dir-list idet-people-list list-scroll">
            <div className="list-head" style={rowStyle}>
              {shownCols.map((c) => (
                <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                         onToggleSort={() => toggleSort(c.key)}
                         className={headerDrag.dropClass(c.key)}
                         dragProps={headerDrag.dragProps(c.key)}>
                  <ColumnMenu colKey={c.key} label={c.label}
                              allRows={children} filters={filters} text={cellText}
                              filter={filters[c.key]} onFilter={setFilter}
                              sortDir={sortKey === c.key ? sortDir : null}
                              onSort={(dir) => setSort(c.key, dir)} />
                </ColHead>
              ))}
              {canEdit && <span className="col-head" aria-hidden="true" />}
            </div>

            {visible.length === 0 && (
              <div className="dir-empty">
                <b>No matches</b>Try a different search or filter.
                <EmptyClearFilters filters={filters} onClear={clearFilters} />
              </div>
            )}

            <VirtualRows rows={visible}
              renderRow={(o, vp) => (
                <div key={o.id} className="dir-row" {...vp}
                     style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle}>
                    {shownCols.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(o, c.key)}</div>
                    ))}
                    {canEdit && (
                      <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <RowActionsMenu actions={[{
                          key: 'remove', label: 'Remove', destructive: true,
                          onSelect: () => void remove(o),
                        }]} />
                      </div>
                    )}
                  </div>
                </div>
              )} />
          </div>
        </>
      )}

      {adding && (
        <AddChildModal
          partner={partner}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); void load(); }}
        />
      )}
    </div>
  );
}

/* ── Add child modal ───────────────────────────────────────────────── */

function AddChildModal({ partner, onClose, onAdded }: {
  partner: OrgItem;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [rows, setRows] = useState<OrgItem[] | null>(null);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void listPartnerItems()
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) { setRows([]); setError('Could not load partners.'); } });
    return () => { alive = false; };
  }, []);

  // A child must have no parent already, and can't be this partner or one of
  // its ancestors (that would loop). The API refuses both regardless.
  const options = useMemo(() => {
    const all = rows ?? [];
    const ancestors = partnerAncestorIds(all, partner.id);
    return all
      .filter((r) => !r.parent_id && r.id !== partner.id && !ancestors.has(r.id))
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((r) => ({ value: r.id, label: r.name, sub: r.archived_at ? 'Archived' : r.code }));
  }, [rows, partner.id]);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await setPartnerParent(pick, partner.id);
      onAdded();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card reports-modal-card rgm-card add-child-card" role="dialog"
           aria-label="Add a child partner">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Partners</div>
            <h3>Add a child partner</h3>
            <p className="page-hint">
              Place an existing partner under {partner.name}. Only partners that don’t
              already have a parent are listed.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Partner</label>
              <ComboBox options={options} value={pick} onChange={setPick}
                        placeholder={rows === null ? 'Loading…' : 'Type to search partners…'}
                        disabled={saving} /></div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={() => void submit()}
                  disabled={!pick || saving}>
            {saving ? 'Adding…' : 'Add as child'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
