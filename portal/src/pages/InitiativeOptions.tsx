/**
 * InitiativeOptions — vocabulary management for the five status_values
 * record types that drive the initiative forms: `initiative_type`,
 * `initiative` (statuses), `initiative_sub_type`, `initiative_work_type`,
 * and `shipping_type`. One tab per record type, each backed by the same
 * per-type list endpoint the initiative forms themselves use (see
 * lib/api.ts's listInitiativeTypes/listInitiativeStatuses/etc.).
 *
 * Lifts the minimal list/edit pattern from pages/Variables.tsx's Statuses
 * tab — list rows with a colour chip, label, description, sort order, and
 * active state, with add/edit behind StatusEditModal — but drops what
 * doesn't apply here: no record-type facet (each tab is already scoped to
 * one type) and no usage-count column (that's the devtools-only unfiltered
 * list branch; this page's fetches are the resource-scoped ones).
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import StatusEditModal, { ColorSwatch } from '../components/variables/StatusEditModal';
import { ADMIN_RANK } from '../lib/access';
import {
  ApiError,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listInitiativeWorkTypes,
  listShippingTypes,
  type StatusValue,
} from '../lib/api';
import '../styles/access.css';   /* .subs-tabs / .access-tab-panel — page-local tab strip */
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/sites.css';    /* .pf-form textarea */

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

type TabId = 'types' | 'statuses' | 'sub-types' | 'work-types' | 'shipping-types';

interface TabDef {
  id: TabId;
  label: string;
  noun: string;   // singular, lowercase — used in copy ("+ New type", "load types")
  fetchValues: () => Promise<StatusValue[]>;
}

const TABS: TabDef[] = [
  { id: 'types', label: 'Types', noun: 'type', fetchValues: listInitiativeTypes },
  { id: 'statuses', label: 'Statuses', noun: 'status', fetchValues: listInitiativeStatuses },
  { id: 'sub-types', label: 'Sub-types', noun: 'sub-type', fetchValues: listInitiativeSubTypes },
  { id: 'work-types', label: 'Work types', noun: 'work type', fetchValues: listInitiativeWorkTypes },
  { id: 'shipping-types', label: 'Shipping types', noun: 'shipping type', fetchValues: listShippingTypes },
];

export default function InitiativeOptions() {
  const [tab, setTab] = useState<TabId>('types');
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Initiatives</div>
          <h1 className="page-title">Options</h1>
          <p className="page-hint">
            The vocabularies that drive the initiative forms — types, statuses, sub-types,
            work types, and shipping types.
          </p>
        </div>
      </div>

      <div className="subs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
                  className={tab === t.id ? 'on' : ''}
                  onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="access-tab-panel">
        <VocabTab key={active.id} label={active.label} noun={active.noun}
                  fetchValues={active.fetchValues} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════ Vocab tab ══════════════════════════════ */

function vocabRowSearchText(v: StatusValue): string {
  return [v.key, v.label, v.description].join(' ').toLowerCase();
}

function VocabTab({ label, noun, fetchValues }: {
  label: string;
  noun: string;
  fetchValues: () => Promise<StatusValue[]>;
}) {
  const { maxRank } = useAuth();
  const isAdmin = maxRank >= ADMIN_RANK;

  const [values, setValues] = useState<StatusValue[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<StatusValue | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setValues(await fetchValues());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? `You do not have permission to view ${label.toLowerCase()}.`
        : `Failed to load ${label.toLowerCase()}.`);
    }
  };

  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    if (!values) return [];
    const q = query.trim().toLowerCase();
    const rows = q ? values.filter((v) => vocabRowSearchText(v).includes(q)) : values;
    return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
  }, [values, query]);

  useEffect(() => {
    if (values && openKey && !visible.some((v) => v.key === openKey)) setOpenKey(null);
  }, [values, visible, openKey]);

  const grid = { gridTemplateColumns: '1fr 1.2fr 2fr 0.8fr 0.6fr 0.6fr 30px' };

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input placeholder="Filter this list…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="result-count">{visible.length} of {values?.length ?? 0} shown</span>
        {isAdmin && (
          <button className="btn-solid" onClick={() => setCreating(true)}>+ New {noun}</button>
        )}
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load {label.toLowerCase()}</b>{error}
        </div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span>Key</span>
            <span>Label</span>
            <span>Description</span>
            <span>Colour</span>
            <span>Order</span>
            <span>Active</span>
            <span />
          </div>

          {values && visible.length === 0 && (
            <div className="dir-empty"><b>No matches</b>Try a different filter.</div>
          )}

          {visible.map((v) => {
            const open = openKey === v.key;
            return (
              <div key={v.key} className={`dir-row ${open ? 'open' : ''}`}>
                <div className="row-main" style={grid} onClick={() => setOpenKey(open ? null : v.key)}>
                  <div className="cell"><span className="mono">{v.key}</span></div>
                  <div className="cell"><span className="cell-top">{v.label}</span></div>
                  <div className="cell"><span className="cell-sub">{v.description || '—'}</span></div>
                  <div className="cell"><ColorSwatch color={v.color} /></div>
                  <div className="cell"><span className="mono">{v.sort_order}</span></div>
                  <div className="cell">
                    <span className={`chip ${v.is_active ? 'c-green' : 'tag'}`}>
                      {v.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="cell chevron-cell"><ChevronIcon /></div>
                </div>
                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <VocabRowDetail value={v} canEdit={isAdmin}
                                        onEdit={() => setEditingRow(v)} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingRow && (
        <StatusEditModal value={editingRow} canChange={isAdmin}
                          onClose={() => setEditingRow(null)} onSaved={() => load()} />
      )}
      {creating && (
        <StatusEditModal value={null} canChange={isAdmin}
                          onClose={() => setCreating(false)} onSaved={() => load()} />
      )}
    </>
  );
}

function VocabRowDetail({ value, canEdit, onEdit }: {
  value: StatusValue;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Description</p>
        <p className="set-note" style={{ padding: 0 }}>{value.description || 'No description.'}</p>

        <p className="eyebrow-sm">Colour</p>
        <dl className="kv">
          <dt>Hex</dt>
          <dd className="mono">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <ColorSwatch color={value.color} />{value.color}
            </span>
          </dd>
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
