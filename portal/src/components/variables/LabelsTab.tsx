/**
 * Variables → Labels: the four label vocabularies + the placeholder
 * catalog, one pane per dataset behind an inner segmented control.
 * Same simple directory-list pattern as the sibling Variables tabs;
 * mutations live in edit modals, devtools-gated server-side.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, listLabelPlaceholders, listLabelVocab,
  type LabelPlaceholder, type LabelVocab,
} from '../../lib/api';
import {
  VOCAB_KIND_LABELS, metaSummary, placeholderSearchText, vocabSearchText,
  type VocabKind,
} from '../../lib/labels';
import { ColHead, listGridStyle, listScale, titleFor, type ColumnDef } from '../../lib/listTools';
import LabelPlaceholderEditModal from './LabelPlaceholderEditModal';
import LabelVocabEditModal from './LabelVocabEditModal';

type Pane = VocabKind | 'placeholders';

const PANES: { id: Pane; label: string }[] = [
  { id: 'type', label: 'Types' },
  { id: 'size', label: 'Sizes' },
  { id: 'dpi', label: 'DPI' },
  { id: 'language', label: 'Languages' },
  { id: 'placeholders', label: 'Placeholders' },
];

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
  );
}

export default function LabelsTab() {
  const [pane, setPane] = useState<Pane>('type');
  const [vocab, setVocab] = useState<LabelVocab[] | null>(null);
  const [placeholders, setPlaceholders] = useState<LabelPlaceholder[] | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [v, p] = await Promise.all([listLabelVocab(), listLabelPlaceholders()]);
      setVocab(v);
      setPlaceholders(p);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view label variables.'
        : 'Failed to load label variables.');
    }
  };
  useEffect(() => { void load(); }, []);

  return (
    <div>
      <div className="segmented" role="tablist" style={{ marginBottom: 14 }}>
        {PANES.map((p) => (
          <button key={p.id} role="tab" aria-selected={pane === p.id}
                  className={pane === p.id ? 'on' : ''}
                  onClick={() => setPane(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {error && <div className="dir-empty" style={{ marginBottom: 12 }}>
        <b>Cannot load label variables</b>{error}</div>}
      {pane !== 'placeholders' && vocab && (
        <VocabPane kind={pane} rows={vocab.filter((v) => v.kind === pane)}
                   onSaved={load} />
      )}
      {pane === 'placeholders' && placeholders && vocab && (
        <PlaceholderPane rows={placeholders}
                         typeOptions={vocab.filter((v) => v.kind === 'type')}
                         onSaved={load} />
      )}
    </div>
  );
}

/* ══════════════════════════════ Vocab pane ══════════════════════════════ */

const VOCAB_SINGULAR: Record<VocabKind, string> = {
  type: 'type', size: 'size', dpi: 'DPI', language: 'language',
};

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). Read-only, unsortable list —
// headers render as plain ColHead spans (no onToggleSort). Trailing 30px
// track is the row's expansion chevron.
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — this list sits
// in the Variables page's tab body, the .access-tab-panel div Variables.tsx
// borrows from access.css, which carries no padding of its own beyond
// .portal-page's; at a 1512px window, nav expanded).
const VOCAB_COLUMNS: ColumnDef[] = [
  { key: 'key', label: 'Key', width: '1fr', default: true, min: 100 },
  { key: 'label', label: 'Label', width: '1.2fr', default: true, min: 140 },
  { key: 'description', label: 'Description', width: '2fr', default: true },
  { key: 'meta', label: 'Meta', width: '1.2fr', default: true },
  { key: 'order', label: 'Order', width: '0.6fr', default: true },
  { key: 'active', label: 'Active', width: '0.7fr', default: true },
  { key: 'in_use', label: 'In use', width: '0.7fr', default: true },
];
const VOCAB_TRAILING = ['30px'];

function VocabPane({ kind, rows, onSaved }: {
  kind: VocabKind;
  rows: LabelVocab[];
  onSaved: () => Promise<void> | void;
}) {
  const { can, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canAdd = can('devtools', 'add');
  const canChange = can('devtools', 'change');

  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<LabelVocab | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((v) => (q ? vocabSearchText(v).includes(q) : true));
    return filtered.sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
  }, [rows, query]);

  useEffect(() => {
    if (openKey && !visible.some((v) => v.key === openKey)) setOpenKey(null);
  }, [visible, openKey]);

  const grid = listGridStyle(VOCAB_COLUMNS, VOCAB_TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {rows.length} shown</span>
        {canAdd && (
          <button className="btn-solid" onClick={() => setCreating(true)}>
            + New {VOCAB_SINGULAR[kind]}
          </button>
        )}
      </div>

      <div className="dir-list list-scroll">
        <div className="list-head" style={rowStyle}>
          {VOCAB_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
          <span className="col-head" aria-hidden="true" />
        </div>

        {visible.length === 0 && (
          <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
        )}

        {visible.map((v) => {
          const open = openKey === v.key;
          const meta = metaSummary(v) || '—';
          return (
            <div key={v.key} className={`dir-row ${open ? 'open' : ''}`}
                 style={{ minWidth: rowStyle.minWidth }}>
              <div className="row-main" style={rowStyle} onClick={() => setOpenKey(open ? null : v.key)}>
                <div className="cell"><span className="mono cell-line" title={titleFor(v.key)}>{v.key}</span></div>
                <div className="cell"><span className="cell-top cell-line" title={titleFor(v.label)}>{v.label}</span></div>
                <div className="cell">
                  <span className="cell-sub cell-line" title={titleFor(v.description || '—')}>
                    {v.description || '—'}
                  </span>
                </div>
                <div className="cell"><span className="mono cell-line" title={titleFor(meta)}>{meta}</span></div>
                <div className="cell"><span className="mono cell-line">{v.sort_order}</span></div>
                <div className="cell">
                  <span className={`chip ${v.is_active ? 'c-green' : 'c-slate'}`}>
                    {v.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="cell"><span className="mono cell-line">{v.usage_count ?? 0}</span></div>
                <div className="cell chevron-cell"><ChevronIcon /></div>
              </div>
              <div className="detail">
                <div className="detail-clip">
                  <div className="detail-inner">
                    {open && (
                      <VocabRowDetail value={v} canEdit={canChange}
                                      onEdit={() => setEditingRow(v)} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingRow && (
        <LabelVocabEditModal kind={kind} value={editingRow} canChange={canChange}
                              onClose={() => setEditingRow(null)} onSaved={() => onSaved()} />
      )}
      {creating && (
        <LabelVocabEditModal kind={kind} value={null} canChange={canChange}
                              onClose={() => setCreating(false)} onSaved={() => onSaved()} />
      )}
    </>
  );
}

function VocabRowDetail({ value, canEdit, onEdit }: {
  value: LabelVocab;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>

        <p className="eyebrow-sm">Meta</p>
        <dl className="kv">
          <dt>Kind</dt>
          <dd>{VOCAB_KIND_LABELS[value.kind as VocabKind] ?? value.kind}</dd>
          <dt>Raw meta</dt>
          <dd className="mono">{JSON.stringify(value.meta)}</dd>
        </dl>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Ordering &amp; usage</p>
        <dl className="kv">
          <dt>Sort order</dt>
          <dd className="mono">{value.sort_order}</dd>
          <dt>Active</dt>
          <dd>{value.is_active ? 'Yes' : 'No'}</dd>
          <dt>In use</dt>
          <dd>{value.usage_count ?? 0} template{(value.usage_count ?? 0) === 1 ? '' : 's'}</dd>
        </dl>
      </div>

      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════ Placeholder pane ═══════════════════════════ */

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). Read-only, unsortable list —
// headers render as plain ColHead spans (no onToggleSort). Trailing 30px
// track is the row's expansion chevron.
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — this list sits
// in the Variables page's tab body, the .access-tab-panel div Variables.tsx
// borrows from access.css, which carries no padding of its own beyond
// .portal-page's; at a 1512px window, nav expanded).
const PLACEHOLDER_COLUMNS: ColumnDef[] = [
  { key: 'key', label: 'Key', width: '1fr', default: true, min: 100 },
  { key: 'label', label: 'Label', width: '1.2fr', default: true, min: 140 },
  { key: 'sample', label: 'Sample', width: '1fr', default: true },
  { key: 'applies_to', label: 'Applies to', width: '1.6fr', default: true },
  { key: 'order', label: 'Order', width: '0.6fr', default: true },
  { key: 'active', label: 'Active', width: '0.7fr', default: true },
  { key: 'in_use', label: 'In use', width: '0.7fr', default: true },
];
const PLACEHOLDER_TRAILING = ['30px'];

function PlaceholderPane({ rows, typeOptions, onSaved }: {
  rows: LabelPlaceholder[];
  typeOptions: LabelVocab[];
  onSaved: () => Promise<void> | void;
}) {
  const { can, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canAdd = can('devtools', 'add');
  const canChange = can('devtools', 'change');

  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<LabelPlaceholder | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((p) => (q ? placeholderSearchText(p).includes(q) : true));
    return filtered.sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
  }, [rows, query]);

  useEffect(() => {
    if (openKey && !visible.some((p) => p.key === openKey)) setOpenKey(null);
  }, [visible, openKey]);

  const grid = listGridStyle(PLACEHOLDER_COLUMNS, PLACEHOLDER_TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {rows.length} shown</span>
        {canAdd && (
          <button className="btn-solid" onClick={() => setCreating(true)}>+ New placeholder</button>
        )}
      </div>

      <div className="dir-list list-scroll">
        <div className="list-head" style={rowStyle}>
          {PLACEHOLDER_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
          <span className="col-head" aria-hidden="true" />
        </div>

        {visible.length === 0 && (
          <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
        )}

        {visible.map((p) => {
          const open = openKey === p.key;
          const sample = p.sample_value || '—';
          return (
            <div key={p.key} className={`dir-row ${open ? 'open' : ''}`}
                 style={{ minWidth: rowStyle.minWidth }}>
              <div className="row-main" style={rowStyle} onClick={() => setOpenKey(open ? null : p.key)}>
                <div className="cell"><span className="mono cell-line" title={titleFor(p.key)}>{p.key}</span></div>
                <div className="cell"><span className="cell-top cell-line" title={titleFor(p.label)}>{p.label}</span></div>
                <div className="cell"><span className="mono cell-line" title={titleFor(sample)}>{sample}</span></div>
                <div className="cell">
                  <div className="chips">
                    {p.applies_to.length === 0 && <span className="chip tag">—</span>}
                    {p.applies_to.map((t) => <span key={t} className="chip tag">{t}</span>)}
                  </div>
                </div>
                <div className="cell"><span className="mono cell-line">{p.sort_order}</span></div>
                <div className="cell">
                  <span className={`chip ${p.is_active ? 'c-green' : 'c-slate'}`}>
                    {p.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="cell"><span className="mono cell-line">{p.usage_count ?? 0}</span></div>
                <div className="cell chevron-cell"><ChevronIcon /></div>
              </div>
              <div className="detail">
                <div className="detail-clip">
                  <div className="detail-inner">
                    {open && (
                      <PlaceholderRowDetail value={p} canEdit={canChange}
                                            onEdit={() => setEditingRow(p)} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingRow && (
        <LabelPlaceholderEditModal value={editingRow} typeOptions={typeOptions} canChange={canChange}
                                    onClose={() => setEditingRow(null)} onSaved={() => onSaved()} />
      )}
      {creating && (
        <LabelPlaceholderEditModal value={null} typeOptions={typeOptions} canChange={canChange}
                                    onClose={() => setCreating(false)} onSaved={() => onSaved()} />
      )}
    </>
  );
}

function PlaceholderRowDetail({ value, canEdit, onEdit }: {
  value: LabelPlaceholder;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>

        <p className="eyebrow-sm">Sample value</p>
        <dl className="kv">
          <dt>Sample</dt>
          <dd className="mono">{value.sample_value || '—'}</dd>
        </dl>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Applies to</p>
        <div className="chips">
          {value.applies_to.length === 0 && <span className="chip tag">No label types</span>}
          {value.applies_to.map((t) => <span key={t} className="chip tag">{t}</span>)}
        </div>

        <p className="eyebrow-sm">Ordering &amp; usage</p>
        <dl className="kv">
          <dt>Sort order</dt>
          <dd className="mono">{value.sort_order}</dd>
          <dt>Active</dt>
          <dd>{value.is_active ? 'Yes' : 'No'}</dd>
          <dt>In use</dt>
          <dd>{value.usage_count ?? 0} template{(value.usage_count ?? 0) === 1 ? '' : 's'}</dd>
        </dl>
      </div>

      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
