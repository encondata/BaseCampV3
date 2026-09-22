/**
 * Makes / Models — the hardware catalog backing the Assets registry: specs,
 * mounting, and field knowledge per make/model. Directory pattern with a
 * read-only detail panel (specs + field knowledge/aliases). All mutation
 * (create/edit) lands in ModelEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import ModelEditModal from '../components/assets/ModelEditModal';
import ModelMergeModal from '../components/assets/ModelMergeModal';
import ModelReviewPanel from '../components/assets/ModelReviewPanel';
import GodDeleteButton from '../components/GodDeleteButton';
import {
  ApiError,
  listAssetCategories,
  listAssetModels,
  reviewAssetModels,
  updateAssetModel,
  type AssetCategoryOut,
  type AssetModelItem,
  type MergePlanOut,
  type ReviewOut,
} from '../lib/api';
import {
  MODEL_ERRORS, MODEL_GOD_FIELDS, formatDims, formFactorLabel, modelCellText, modelSearchText,
  titleCase,
} from '../lib/assets';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { useToast } from '../lib/notificationsContext';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { naturalCompare } from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  applyColumnOrder,
  ColumnsButton,
  ExportButton,
  exportCsv,
  moveKey,
  useReorderDrag,
  useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';

const COLUMNS: ColumnDef[] = [
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: true },
  { key: 'weight', label: 'Weight', width: '1.2fr', default: true },
  { key: 'dims', label: 'Dimensions', width: '1.6fr', default: true },
  { key: 'mount', label: 'Mount', width: '0.8fr', default: true },
  { key: 'form', label: 'Form factor', width: '0.8fr', default: true },
  { key: 'rail', label: 'Rail type', width: '0.8fr', default: false },
  { key: 'aliases', label: 'Aliases', width: '0.6fr', default: false },
  { key: 'weight_lbs', label: 'Weight (lb)', width: '0.8fr', default: false, godOnly: true },
  { key: 'weight_kg', label: 'Weight (kg)', width: '0.8fr', default: false, godOnly: true },
  { key: 'length_in', label: 'Length (in)', width: '0.8fr', default: false, godOnly: true },
  { key: 'width_in', label: 'Width (in)', width: '0.8fr', default: false, godOnly: true },
  { key: 'height_in', label: 'Height (in)', width: '0.8fr', default: false, godOnly: true },
  { key: 'length_cm', label: 'Length (cm)', width: '0.8fr', default: false, godOnly: true },
  { key: 'width_cm', label: 'Width (cm)', width: '0.8fr', default: false, godOnly: true },
  { key: 'height_cm', label: 'Height (cm)', width: '0.8fr', default: false, godOnly: true },
  { key: 'knowledge', label: 'Knowledge', width: '1.4fr', default: false, godOnly: true },
];

// Every column the page can offer (incl. godOnly) plus the 'primary'
// pseudo-column (the always-shown make+model cell) — so a persisted
// filter/sort/visibility referencing it survives usePersistentListState's
// rehydrate-time sanitization. No 'archived' pseudo-column here: the
// catalog has no archive concept.
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Sort value per column key — deliberately separate from `modelCellText`:
 *  that accessor's job is display/filter text (formatted weight/dims
 *  strings, dashes for blanks), which would sort wrong (e.g. "50 lb / 22.68
 *  kg" sorts lexicographically, not by magnitude). This stays raw/lowercase
 *  so naturalCompare orders rows the way a user expects. */
function sortValueFor(m: AssetModelItem, key: string): string {
  switch (key) {
    case 'primary': return `${m.make} ${m.model}`.toLowerCase();
    case 'category': return (m.category_label ?? '').toLowerCase();
    case 'ru': return String(m.ru_size ?? 0);
    case 'weight': return String(m.weight_lbs ?? 0);
    case 'dims': return String(m.length_in ?? 0);
    case 'mount': return (m.mount_type ?? '').toLowerCase();
    case 'form': return (m.form_factor ?? '').toLowerCase();
    case 'rail': return (m.rail_type ?? '').toLowerCase();
    case 'aliases': return m.aliases.join(' ').toLowerCase();
    case 'weight_lbs': return String(m.weight_lbs ?? 0);
    case 'weight_kg': return String(m.weight_kg ?? 0);
    case 'length_in': return String(m.length_in ?? 0);
    case 'width_in': return String(m.width_in ?? 0);
    case 'height_in': return String(m.height_in ?? 0);
    case 'length_cm': return String(m.length_cm ?? 0);
    case 'width_cm': return String(m.width_cm ?? 0);
    case 'height_cm': return String(m.height_cm ?? 0);
    case 'knowledge': return m.knowledge.toLowerCase();
    default: return '';
  }
}

const CSV_COLUMNS: [string, (m: AssetModelItem) => string][] = [
  ['ID', (m) => m.id],
  ['Make', (m) => m.make],
  ['Model', (m) => m.model],
  ['Category', (m) => m.category_label ?? ''],
  ['RU', (m) => (m.ru_size === null ? '' : String(m.ru_size))],
  ['Weight (lb)', (m) => (m.weight_lbs === null ? '' : String(m.weight_lbs))],
  ['Weight (kg)', (m) => (m.weight_kg === null ? '' : String(m.weight_kg))],
  ['Length (in)', (m) => (m.length_in === null ? '' : String(m.length_in))],
  ['Width (in)', (m) => (m.width_in === null ? '' : String(m.width_in))],
  ['Height (in)', (m) => (m.height_in === null ? '' : String(m.height_in))],
  ['Mount type', (m) => m.mount_type ?? ''],
  ['Form factor', (m) => m.form_factor ?? ''],
  ['Rail type', (m) => m.rail_type ?? ''],
  ['Aliases', (m) => m.aliases.join('; ')],
  ['Knowledge', (m) => m.knowledge],
  ['Created', (m) => m.created_at],
];

export default function AssetModels() {
  const { can, godMode } = useAuth();
  const canAdd = can('asset_models', 'add');
  const canChange = can('asset_models', 'change');
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [models, setModels] = useState<AssetModelItem[] | null>(null);
  const [categories, setCategories] = useState<AssetCategoryOut[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  // See Assets.tsx for the full rationale — the id of the most recent
  // deep-link arrival, as opposed to a plain row click (which never touches
  // this ref), so an unrelated later filter edit can't be mistaken for a
  // fresh arrival and re-trigger the once-per-id clearFilters() below.
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null; // re-arm: a fresh arrival gets its own one-shot clear
    setOpenId(id);
  };
  useRecordFocus(models, (m) => m.id, (m) => `${m.make} ${m.model}`, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'asset_models', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'all' | 'review'>('all');
  const [merging, setMerging] = useState<{ source: AssetModelItem; presetTargetId: string | null } | null>(null);
  const [reviewKey, setReviewKey] = useState(0);
  // The review payload lives here, not in ModelReviewPanel: the Review tab's
  // count badge needs it even while the All view is showing.
  const [reviewData, setReviewData] = useState<ReviewOut | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      setModels(await listAssetModels());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view the catalog.' : 'Failed to load models.');
    }
  };

  useEffect(() => {
    void load();
    void listAssetCategories().then(setCategories).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    reviewAssetModels(showDismissed)
      .then((d) => { if (live) { setReviewData(d); setReviewError(''); } })
      .catch((err) => {
        if (live) {
          setReviewError(err instanceof ApiError && err.status === 403
            ? 'You do not have permission to view the catalog.'
            : 'Failed to load the review list.');
        }
      });
    return () => { live = false; };
  }, [showDismissed, reviewKey]);

  // What still wants a human decision: every model the review returned, once
  // each (a model can be both import-created and part of a duplicate group).
  // Dismissed rows are excluded even while "Show dismissed" is on.
  const reviewCount = useMemo(() => {
    if (!reviewData) return null;
    const ids = new Set<string>();
    for (const m of [...reviewData.imported, ...reviewData.duplicates.flat()]) {
      if (m.review_dismissed_at === null) ids.add(m.id);
    }
    return ids.size;
  }, [reviewData]);

  const godFields = useMemo(() => MODEL_GOD_FIELDS({
    categories: () => categories.map((c) => ({ value: c.key, label: c.label })),
  }), [categories]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: AssetModelItem) =>
    setModels((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const haystack = useSearchHaystacks(models, modelSearchText);

  const visible = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    const rows = models.filter((m) => {
      if (!passesColumnFilters(m, filters, modelCellText)) return false;
      if (!q) return true;
      return haystack(m).includes(q);
    });
    return rows.sort((a, b) => naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [models, filters, query, sortKey, sortDir, haystack]);

  // Auto-close the open row when it drops out of `visible` — EXCEPT the one
  // case where it just arrived via a deep link and the reason it's missing
  // is a persisted column filter: then clear the filters instead. See
  // Assets.tsx for the full rationale.
  useEffect(() => {
    if (!models || !openId || visible.some((m) => m.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = models.find((m) => m.id === openId);
      if (target && !passesColumnFilters(target, filters, modelCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [models, visible, openId, filters, clearFilters]);

  // Release the deep-link guard once the target row is first confirmed
  // visible — see Assets.tsx for the full rationale.
  useEffect(() => {
    if (deepLinkTarget.current && visible.some((m) => m.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const editingModel = editingId === null
    ? null : (models?.find((m) => m.id === editingId) ?? null);

  const cellFor = (m: AssetModelItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={m} gf={gf} patch={updateAssetModel} onRowSaved={replaceRow}
                   errorMap={MODEL_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'category':
        return (
          <div className="chips">
            {m.category_color
              ? (
                <span className="chip custom" style={{ '--chip': m.category_color } as CSSProperties}>
                  <span className="dot" />{m.category_label}
                </span>
              )
              : <span className="chip tag">{m.category_label ?? '—'}</span>}
            {pd.pendingIds.has(m.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'ru':
        return <span className="mono">{m.ru_size ?? '—'}</span>;
      case 'weight':
        return <span className="cell-top">
          {m.weight_lbs !== null ? `${m.weight_lbs} lb / ${m.weight_kg} kg` : '—'}
        </span>;
      case 'dims':
        return <span className="cell-top">{formatDims(m.length_in, m.width_in, m.height_in, 'in')}</span>;
      case 'mount':
        return <span className="cell-top">{titleCase(m.mount_type)}</span>;
      case 'form':
        return m.form_factor
          ? <span className="chip tag">{formFactorLabel(m.form_factor)}</span>
          : <span className="cell-top">—</span>;
      case 'rail':
        return <span className="mono">{m.rail_type ?? '—'}</span>;
      case 'aliases':
        return <span className="cell-top">{m.aliases.length ? m.aliases.join(', ') : '—'}</span>;
      case 'weight_lbs':
        return <span className="mono">{m.weight_lbs ?? '—'}</span>;
      case 'weight_kg':
        return <span className="mono">{m.weight_kg ?? '—'}</span>;
      case 'length_in':
        return <span className="mono">{m.length_in ?? '—'}</span>;
      case 'width_in':
        return <span className="mono">{m.width_in ?? '—'}</span>;
      case 'height_in':
        return <span className="mono">{m.height_in ?? '—'}</span>;
      case 'length_cm':
        return <span className="mono">{m.length_cm ?? '—'}</span>;
      case 'width_cm':
        return <span className="mono">{m.width_cm ?? '—'}</span>;
      case 'height_cm':
        return <span className="mono">{m.height_cm ?? '—'}</span>;
      case 'knowledge':
        return <span className="cell-top">{m.knowledge || '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="page-title">
            Makes / Models
            <span className="badge-count">{models?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            The hardware catalog — specs, mounting, and field knowledge per make/model.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist" aria-label="Catalog view">
          <button role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''}
                  onClick={() => setView('all')}>All</button>
          <button role="tab" aria-selected={view === 'review'} className={view === 'review' ? 'on' : ''}
                  onClick={() => setView('review')}>
            {/* the space is load-bearing: without it the tab's accessible
                name is "Review3" */}
            Review{reviewCount !== null && <>{' '}<span className="badge-count">{reviewCount}</span></>}
          </button>
        </div>
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {models?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('asset-models', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New model
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load catalog</b>{error}</div>}

      {!error && view === 'all' && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Make / Model {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Make / Model"
                          allRows={models ?? []} filters={filters}
                          text={modelCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={models ?? []} filters={filters}
                            text={modelCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {models && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a model.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(m, vp) => {
            const open = openId === m.id;
            return (
              <div key={m.id} className={`dir-row ${open ? 'open' : ''}`}
                   {...vp} style={vp?.style}>
                <div className="row-main" style={grid}
                     onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : m.id); }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') && godFieldFor('primary2') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={m} gf={godFieldFor('primary')!} patch={updateAssetModel}
                                 onRowSaved={replaceRow} errorMap={MODEL_ERRORS} disabled={!canChange} />
                        <GodCell row={m} gf={godFieldFor('primary2')!} patch={updateAssetModel}
                                 onRowSaved={replaceRow} errorMap={MODEL_ERRORS} disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{m.make}</b><span>{m.model}</span></div>
                    )}
                  </div>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(m, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <ModelRowDetail
                          model={m}
                          canEdit={canChange}
                          onEdit={() => setEditingId(m.id)}
                          onMerge={() => setMerging({ source: m, presetTargetId: null })}
                          godVisible={godMode}
                          pending={pd.pendingIds.has(m.id)}
                          onMark={() => pd.mark('asset_model', m.id, `${m.make} ${m.model}`)}
                          onUnmark={() => pd.unmark(m.id)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          }} />
        </div>
      )}

      {!error && view === 'review' && (
        <ModelReviewPanel canChange={canChange} data={reviewData} loadError={reviewError}
                          showDismissed={showDismissed} onToggleDismissed={setShowDismissed}
                          onChanged={() => setReviewKey((k) => k + 1)}
                          onMerge={(source, presetTargetId) => setMerging({ source, presetTargetId })}
                          onEdit={(id) => setEditingId(id)} />
      )}

      {/* editingModel, never `?? null`: an id the catalog doesn't have would
          otherwise open ModelEditModal in CREATE mode. */}
      {editingModel && (
        <ModelEditModal
          model={editingModel}
          categories={categories}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => { void load(); setReviewKey((k) => k + 1); }}
        />
      )}
      {creating && (
        <ModelEditModal
          model={null}
          categories={categories}
          canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => { void load(); setReviewKey((k) => k + 1); }}
        />
      )}
      {merging && models && (
        <ModelMergeModal source={merging.source} models={models} presetTargetId={merging.presetTargetId}
                         onClose={() => setMerging(null)}
                         onMerged={(plan: MergePlanOut) => {
                           setMerging(null);
                           toast(`Merged ${plan.source.make} ${plan.source.model} into ${plan.target.make} ${plan.target.model}: ${plan.moves.assets} asset${plan.moves.assets === 1 ? '' : 's'} moved`);
                           void load();
                           setReviewKey((k) => k + 1);
                           // opening a row only means anything on the All view
                           if (view === 'all') setOpenId(plan.target.id);
                         }} />
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. ─────────────────────────────────────────────────────── */

function ModelRowDetail({
  model, canEdit, onEdit, onMerge, godVisible, pending, onMark, onUnmark,
}: {
  model: AssetModelItem; canEdit: boolean; onEdit: () => void; onMerge: () => void;
  godVisible: boolean; pending: boolean;
  onMark: () => Promise<void>; onUnmark: () => Promise<void>;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Specifications</p>
        <dl className="kv">
          <dt>Category</dt><dd>{model.category_label ?? '—'}</dd>
          <dt>RU size</dt><dd>{model.ru_size ?? '—'}</dd>
          <dt>Weight</dt>
          <dd>{model.weight_lbs !== null ? `${model.weight_lbs} lb / ${model.weight_kg} kg` : '—'}</dd>
          <dt>Dimensions (in)</dt>
          <dd>{formatDims(model.length_in, model.width_in, model.height_in, 'in')}</dd>
          <dt>Dimensions (cm)</dt>
          <dd>{formatDims(model.length_cm, model.width_cm, model.height_cm, 'cm')}</dd>
          <dt>Mount type</dt><dd>{titleCase(model.mount_type)}</dd>
          <dt>Form factor</dt><dd>{formFactorLabel(model.form_factor)}</dd>
          <dt>Rail type</dt><dd>{model.rail_type ?? '—'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Field knowledge</p>
        {model.knowledge
          ? <div className="knowledge-block">{model.knowledge}</div>
          : <p className="page-hint">No tips recorded yet.</p>}
        <p className="eyebrow-sm" style={{ marginTop: 12 }}>Aliases</p>
        <div className="chips">
          {model.aliases.length
            ? model.aliases.map((a) => <span key={a} className="chip tag">{a}</span>)
            : <span className="chip tag">none</span>}
        </div>
      </div>
      {(canEdit || godVisible) && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          {canEdit && (
            <>
              <button className="btn-solid" onClick={onEdit}>Edit</button>
              <button className="mini-btn accent" onClick={onMerge}>Merge into…</button>
            </>
          )}
          <GodDeleteButton visible={godVisible} entityType="asset_model" entityId={model.id}
                           label={`${model.make} ${model.model}`} pending={pending}
                           onChange={pending ? onUnmark : onMark} />
        </div>
      )}
    </div>
  );
}
