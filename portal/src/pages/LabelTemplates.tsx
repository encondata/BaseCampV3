/** Label Templates — the directory list of label templates (design/ZPL
 *  builder rows and raw-code rows side by side). Standalone page (own
 *  .portal-page/.dir-head, model: FixedReaders.tsx / HandheldReaders.tsx)
 *  built on the shared directory-list pattern: search + toolbar
 *  FilterButton facet (Type/Size/Language/Kind/Active) + per-column
 *  ColumnMenu filters + persisted visible/sort/order state
 *  (usePersistentListState) + CSV export + virtualized rows.
 *
 *  There is no create-in-place modal here — "New template" opens a small
 *  two-option pop-menu (Visual builder / Raw code) that navigates to the
 *  editor route (Task 15), same for the "Edit" row action. Deactivate/
 *  Activate are in-place: deactivate soft-deletes via deleteLabelTemplate
 *  (after confirm), activate flips is_active back on via
 *  updateLabelTemplate — both re-load(). No row expansion, like
 *  FixedReaders. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, convertLabelTemplate, deleteLabelTemplate, listLabelTemplates, listLabelVocab,
  listSites, updateLabelTemplate,
  type LabelTemplate, type LabelVocab, type SiteItem,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import { siteNames, sitesCellText, templateSearchText, vocabLabel, vocabOfKind } from '../lib/labels';
import {
  ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  moveKey, passesFacets, useOutsideClose, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import '../styles/directory.css';
import '../styles/labels.css';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.6fr', default: true },
  { key: 'label_type', label: 'Type', width: '1fr', default: true },
  { key: 'size_key', label: 'Size', width: '1fr', default: true },
  { key: 'language_key', label: 'Language', width: '1fr', default: true },
  { key: 'dpi_key', label: 'DPI', width: '0.6fr', default: true },
  { key: 'kind', label: 'Kind', width: '0.8fr', default: true },
  { key: 'version', label: 'Ver', width: '0.5fr', default: true },
  { key: 'is_active', label: 'Active', width: '0.7fr', default: true },
  { key: 'sites', label: 'Sites', width: '1.1fr', default: true },
  { key: 'description', label: 'Description', width: '1.6fr', default: false },
  { key: 'updated_at', label: 'Updated', width: '1fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const kindLabel = (kind: LabelTemplate['kind']) => (kind === 'design' ? 'Builder' : 'Raw code');
const activeLabel = (active: boolean) => (active ? 'Active' : 'Inactive');

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't complete that action.";

function NewTemplateMenu({ onPick }: { onPick: (kind: 'design' | 'code') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));

  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="btn-solid" onClick={() => setOpen((v) => !v)}>
        + New template ▾
      </button>
      {open && (
        <div className="pop-menu">
          <button type="button" className="pop-item"
                  onClick={() => { setOpen(false); onPick('design'); }}>
            Visual builder
          </button>
          <button type="button" className="pop-item"
                  onClick={() => { setOpen(false); onPick('code'); }}>
            Raw code (paste ZPL)
          </button>
        </div>
      )}
    </div>
  );
}

export default function LabelTemplates() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canAdd = can('labels', 'add');
  const canChange = can('labels', 'change');
  const canDelete = can('labels', 'delete');

  const [templates, setTemplates] = useState<LabelTemplate[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'labels-templates', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const [t, v, s] = await Promise.all([
        listLabelTemplates(), listLabelVocab(), listSites().catch(() => []),
      ]);
      setTemplates(t);
      setVocab(v);
      setSites(s);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to labels."
        : "Couldn't load label templates.");
    }
  };

  useEffect(() => { void load(); }, []);

  const cellText: CellText<LabelTemplate> = (t, key) => {
    switch (key) {
      case 'label_type': return vocabLabel(vocab, 'type', t.label_type);
      case 'size_key': return vocabLabel(vocab, 'size', t.size_key);
      case 'language_key': return vocabLabel(vocab, 'language', t.language_key);
      case 'dpi_key': return vocabLabel(vocab, 'dpi', t.dpi_key);
      case 'kind': return kindLabel(t.kind);
      case 'version': return String(t.version);
      case 'is_active': return activeLabel(t.is_active);
      case 'sites': return sitesCellText(t.site_ids, sites);
      case 'description': return t.description;
      case 'updated_at': return t.updated_at;
      default: return t.name;
    }
  };

  const sortValue = (t: LabelTemplate, key: string): string | number => {
    if (key === 'version') return t.version;
    if (key === 'is_active') return t.is_active ? 1 : 0;
    return cellText(t, key).toLowerCase();
  };

  const CSV_COLUMNS: [string, (t: LabelTemplate) => string][] = [
    ['ID', (t) => t.id],
    ['Name', (t) => t.name],
    ['Type', (t) => cellText(t, 'label_type')],
    ['Size', (t) => cellText(t, 'size_key')],
    ['Language', (t) => cellText(t, 'language_key')],
    ['DPI', (t) => cellText(t, 'dpi_key')],
    ['Kind', (t) => cellText(t, 'kind')],
    ['Ver', (t) => cellText(t, 'version')],
    ['Active', (t) => cellText(t, 'is_active')],
    ['Sites', (t) => siteNames(t.site_ids, sites).join('; ')],
    ['Description', (t) => t.description],
    ['Updated', (t) => t.updated_at],
  ];

  const searchText = (t: LabelTemplate) =>
    `${templateSearchText(t)} ${siteNames(t.site_ids, sites).join(' ').toLowerCase()}`;
  const haystack = useSearchHaystacks(templates, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => [
    {
      key: 'label_type', title: 'Type',
      options: vocabOfKind(vocab, 'type').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'size_key', title: 'Size',
      options: vocabOfKind(vocab, 'size').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'language_key', title: 'Language',
      options: vocabOfKind(vocab, 'language').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'kind', title: 'Kind',
      options: [{ value: 'design', label: 'Builder' }, { value: 'code', label: 'Raw code' }],
    },
    {
      key: 'is_active', title: 'Active',
      options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
    },
    {
      key: 'sites', title: 'Sites',
      options: [
        { value: '', label: 'All sites (global)' },
        ...Array.from(new Set((templates ?? []).flatMap((t) => t.site_ids)))
          .map((id) => ({ value: id, label: siteNames([id], sites)[0] })),
      ],
    },
  ], [vocab, templates, sites]);

  const facetValues = (t: LabelTemplate) => (groupKey: string): string[] => {
    if (groupKey === 'label_type') return [t.label_type];
    if (groupKey === 'size_key') return [t.size_key];
    if (groupKey === 'language_key') return [t.language_key];
    if (groupKey === 'kind') return [t.kind];
    if (groupKey === 'is_active') return [String(t.is_active)];
    if (groupKey === 'sites') return t.site_ids.length ? t.site_ids : [''];
    return [];
  };

  const visible = useMemo(() => {
    if (!templates) return [];
    const q = query.trim().toLowerCase();
    const rows = templates.filter((t) => {
      if (!passesFacets(facets, facetValues(t))) return false;
      if (!passesColumnFilters(t, filters, cellText)) return false;
      if (!q) return true;
      return haystack(t).includes(q);
    });
    return rows.sort((a, b) => {
      const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, vocab, sites, facets, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 100px` };

  const deactivate = async (t: LabelTemplate) => {
    if (!window.confirm(`Deactivate "${t.name}"?`)) return;
    setError('');
    try {
      await deleteLabelTemplate(t.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const activate = async (t: LabelTemplate) => {
    setError('');
    try {
      await updateLabelTemplate(t.id, { is_active: true });
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const cellFor = (t: LabelTemplate, key: string) => {
    switch (key) {
      case 'name':
        return <span className="cell-primary">{t.name}</span>;
      case 'kind':
        return (
          <span className={`chip ${t.kind === 'design' ? 'c-violet' : 'c-slate'}`}>
            {kindLabel(t.kind)}
          </span>
        );
      case 'is_active':
        return (
          <span className={`chip ${t.is_active ? 'c-green' : 'c-red'}`}>
            {activeLabel(t.is_active)}
          </span>
        );
      case 'sites': {
        const text = sitesCellText(t.site_ids, sites);
        return t.site_ids.length === 0
          ? <span className="cell-sub">{text}</span>
          : <span>{text}</span>;
      }
      case 'description':
        return <span>{t.description || '—'}</span>;
      case 'updated_at':
        return <span>{new Date(t.updated_at).toLocaleDateString()}</span>;
      default:
        return <span>{cellText(t, key)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">
            Templates
            <span className="badge-count">{templates?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">Label templates and the on-screen label builder.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {templates?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('label-templates', CSV_COLUMNS, visible)} />
          {canAdd && (
            <NewTemplateMenu onPick={(kind) => navigate(`/labels/templates/new?kind=${kind}`)} />
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{templates ? "Couldn't complete that action" : 'Cannot load label templates'}</b>{error}
        </div>
      )}

      {templates && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={templates ?? []} filters={filters}
                            text={cellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {visible.length === 0 && (
            templates.length === 0 ? (
              <div className="dir-empty">
                No label templates yet — create the first one.
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters}
                                    onClear={() => { clearFilters(); setFacets({}); }} />
              </div>
            )
          )}

          <VirtualRows rows={visible}
            renderRow={(t, vp) => (
              <div key={t.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(t, c.key)}</div>
                  ))}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <RowActionsMenu actions={[
                      ...(canChange ? [{
                        key: 'edit', label: 'Edit',
                        onSelect: () => navigate(`/labels/templates/${t.id}/edit`),
                      }] : []),
                      ...(canChange && t.kind === 'design' ? [{
                        key: 'convert',
                        label: t.language_key === 'zpl' ? 'Edit as raw ZPL' : 'Edit as raw code',
                        onSelect: () => {
                          if (!window.confirm('One-way: the draggable elements are discarded '
                            + 'and this becomes a raw-code template. Continue?')) return;
                          void convertLabelTemplate(t.id)
                            .then(() => navigate(`/labels/templates/${t.id}/edit`))
                            .catch((err: unknown) => setError(msgFor(err)));
                        },
                      }] : []),
                      ...(t.is_active
                        ? (canDelete ? [{
                            key: 'deactivate', label: 'Deactivate', destructive: true,
                            onSelect: () => void deactivate(t),
                          }] : [])
                        : (canChange ? [{
                            key: 'activate', label: 'Activate',
                            onSelect: () => void activate(t),
                          }] : [])),
                    ]} />
                  </div>
                </div>
              </div>
            )} />
        </div>
      )}
    </div>
  );
}
