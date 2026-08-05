/**
 * Makes / Models — the hardware catalog backing the Assets registry: specs,
 * mounting, and field knowledge per make/model. Directory pattern with a
 * read-only detail panel (specs + field knowledge/aliases). All mutation
 * (create/edit) lands in ModelEditModal.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import ModelEditModal from '../components/assets/ModelEditModal';
import {
  ApiError,
  listAssetCategories,
  listAssetModels,
  type AssetCategoryOut,
  type AssetModelItem,
} from '../lib/api';
import { formatDims, matchesModelFacets, modelSearchText } from '../lib/assets';
import { initialOpenId } from '../lib/auditFormat';
import { naturalCompare } from '../lib/sites';
import { useDeepLinkFilter } from '../lib/useDeepLinkFilter';
import {
  ColumnsButton,
  ExportButton,
  FilterButton,
  exportCsv,
  type ColumnDef,
  type FacetGroup,
  type FacetState,
} from '../lib/listTools';
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
  { key: 'rail', label: 'Rail type', width: '0.8fr', default: false },
  { key: 'aliases', label: 'Aliases', width: '0.6fr', default: false },
];

const MOUNT_OPTIONS = [
  { value: 'rails', label: 'Rails' },
  { value: 'ears', label: 'Ears' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'custom', label: 'Custom' },
];

type SortKey = 'model' | 'category' | 'ru' | 'weight' | 'dims' | 'mount' | 'rail' | 'aliases';

const titleCase = (v: string | null): string =>
  v ? v[0].toUpperCase() + v.slice(1) : '—';

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
  ['Rail type', (m) => m.rail_type ?? ''],
  ['Aliases', (m) => m.aliases.join('; ')],
  ['Knowledge', (m) => m.knowledge],
  ['Created', (m) => m.created_at],
];

export default function AssetModels() {
  const { can } = useAuth();
  const canAdd = can('asset_models', 'add');
  const canChange = can('asset_models', 'change');

  const [models, setModels] = useState<AssetModelItem[] | null>(null);
  const [categories, setCategories] = useState<AssetCategoryOut[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('model');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  useDeepLinkFilter(models, (m) => m.id, (m) => `${m.make} ${m.model}`, setQuery);
  const [facets, setFacets] = useState<FacetState>({});
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'category', title: 'Category',
      options: categories.map((c) => ({ value: c.key, label: c.label })) },
    { key: 'mount', title: 'Mount type', options: MOUNT_OPTIONS },
    { key: 'knowledge', title: 'Field knowledge', options: [
      { value: 'yes', label: 'Has knowledge' }, { value: 'no', label: 'No knowledge' }] },
  ], [categories]);

  const visible = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    const rows = models.filter((m) => {
      if (!matchesModelFacets(m, facets)) return false;
      if (!q) return true;
      return modelSearchText(m).includes(q);
    });
    const val = (m: AssetModelItem): string => {
      switch (sortKey) {
        case 'model': return `${m.make} ${m.model}`.toLowerCase();
        case 'category': return (m.category_label ?? '').toLowerCase();
        case 'ru': return String(m.ru_size ?? 0);
        case 'weight': return String(m.weight_lbs ?? 0);
        case 'dims': return String(m.length_in ?? 0);
        case 'mount': return (m.mount_type ?? '').toLowerCase();
        case 'rail': return (m.rail_type ?? '').toLowerCase();
        case 'aliases': return m.aliases.join(' ').toLowerCase();
      }
    };
    return rows.sort((a, b) => naturalCompare(val(a), val(b)) * sortDir);
  }, [models, facets, query, sortKey, sortDir]);

  useEffect(() => {
    if (models && openId && !visible.some((m) => m.id === openId)) setOpenId(null);
  }, [models, visible, openId]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (m: AssetModelItem, key: string) => {
    switch (key) {
      case 'category':
        return m.category_color
          ? (
            <span className="chip custom" style={{ '--chip': m.category_color } as CSSProperties}>
              <span className="dot" />{m.category_label}
            </span>
          )
          : <span className="chip tag">{m.category_label ?? '—'}</span>;
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
      case 'rail':
        return <span className="mono">{m.rail_type ?? '—'}</span>;
      case 'aliases':
        return <span className="cell-top">{m.aliases.length ? m.aliases.join(', ') : '—'}</span>;
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
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {models?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv('asset-models', CSV_COLUMNS, visible)} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New model
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load catalog</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <button className="sortable" onClick={() => toggleSort('model')}>Make / Model {caret('model')}</button>
            {shownCols.map((c) => (
              <button key={c.key} className="sortable"
                      onClick={() => toggleSort(c.key as SortKey)}>
                {c.label} {caret(c.key as SortKey)}
              </button>
            ))}
            <span />
          </div>

          {models && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a model.
            </div>
          )}

          {visible.map((m) => {
            const open = openId === m.id;
            return (
              <div key={m.id} className={`dir-row ${open ? 'open' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenId(open ? null : m.id)}>
                  <div className="cell cell-primary">
                    <div className="pn"><b>{m.make}</b><span>{m.model}</span></div>
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
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingId !== null && (
        <ModelEditModal
          model={models?.find((m) => m.id === editingId) ?? null}
          categories={categories}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <ModelEditModal
          model={null}
          categories={categories}
          canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. ─────────────────────────────────────────────────────── */

function ModelRowDetail({ model, canEdit, onEdit }: {
  model: AssetModelItem; canEdit: boolean; onEdit: () => void;
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
      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
