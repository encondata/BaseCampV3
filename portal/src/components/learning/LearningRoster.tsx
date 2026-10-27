/**
 * The workers roster on an initiative's Learning tab: a status filter
 * (All / Overdue / In progress / Not opened / Complete) with counts, a
 * search, and one house-list row per person — progress, status, last
 * activity — with a row menu (Resend, Regenerate code, Revoke, View
 * history) and tick boxes for "Resend to selected". The tab owns the data
 * and the calls; this renders them. Anyone without learning:change sees
 * the list read-only (no ticks, no mutating menu items).
 */

import { useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { fullDateTime, relativeTime } from '../../lib/format';
import {
  languageName, type RosterRow, type RosterStatus,
} from '../../lib/learning';
import {
  ColHead, listGridStyle, listScale, type ColumnDef,
} from '../../lib/listTools';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import { STATUS_CHIP } from './initiativeLearning';

export type RosterFilter = 'all' | RosterStatus;

const SEGMENTS: { key: RosterFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'not_opened', label: 'Not opened' },
  { key: 'complete', label: 'Complete' },
];

const CHECKBOX_COL: ColumnDef = { key: 'select', label: '', width: '32px', default: true };

export const ROSTER_COLUMNS: ColumnDef[] = [
  { key: 'worker', label: 'Worker', width: '2fr', default: true, min: 170 },
  { key: 'partner', label: 'Partner', width: '1fr', default: true, min: 100 },
  { key: 'language', label: 'Language', short: 'Lang', width: '0.8fr', default: true, min: 84 },
  { key: 'progress', label: 'Progress', width: '1.2fr', default: true, min: 120 },
  { key: 'status', label: 'Status', width: '1fr', default: true, min: 104 },
  { key: 'activity', label: 'Last activity', short: 'Activity', width: '1fr', default: true, min: 110 },
];

const ACTIONS = '88px';

export default function LearningRoster({
  rows, counts, filter, onFilter, loading, failed, onRetry,
  canChange, canViewWorker, busyId,
  onResend, onRegenerate, onRevoke, onHistory,
}: {
  /** The rows for the current filter; null until the first load. */
  rows: RosterRow[] | null;
  counts: Record<RosterFilter, number>;
  filter: RosterFilter;
  onFilter: (next: RosterFilter) => void;
  /** A refetch is in flight (the rows shown are the previous ones). */
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  canChange: boolean;
  canViewWorker: boolean;
  /** The person whose action is in flight. */
  busyId: string | null;
  onResend: (personIds: string[]) => void;
  onRegenerate: (row: RosterRow) => void;
  onRevoke: (row: RosterRow) => void;
  onHistory: (row: RosterRow) => void;
}) {
  const { preferences } = useAuth();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const segments = SEGMENTS.concat(counts.no_email > 0 || filter === 'no_email'
    ? [{ key: 'no_email' as const, label: 'No email' }] : []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter((r) => `${r.name} ${r.email ?? ''} ${r.partner ?? ''}`.toLowerCase().includes(q));
  }, [rows, query]);

  // ticks follow the rows: someone who left the list can't stay ticked
  const shownIds = new Set(visible.map((r) => r.person_id));
  const selected = visible.filter((r) => picked.has(r.person_id)).map((r) => r.person_id);
  const toggle = (id: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allTicked = visible.length > 0 && selected.length === visible.length;
  const toggleAll = () => setPicked(allTicked ? new Set() : new Set(shownIds));

  const cols = canChange ? [CHECKBOX_COL, ...ROSTER_COLUMNS] : ROSTER_COLUMNS;
  const hasMenu = canChange || canViewWorker;
  const grid = listGridStyle(cols, hasMenu ? [ACTIONS] : [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const actionsFor = (r: RosterRow): RowAction[] => {
    const busy = busyId === r.person_id;
    return [
      ...(canChange ? [
        { key: 'resend', label: 'Resend', disabled: busy, onSelect: () => onResend([r.person_id]) },
        { key: 'regen', label: 'Regenerate code', disabled: busy, onSelect: () => onRegenerate(r) },
        { key: 'revoke', label: 'Revoke', destructive: true, disabled: busy, onSelect: () => onRevoke(r) },
      ] : []),
      ...(canViewWorker ? [{ key: 'history', label: 'View history', onSelect: () => onHistory(r) }] : []),
    ];
  };

  return (
    <section className="lrn-card lrn-roster" aria-label="Workers">
      <div className="lrn-section-head">
        <p className="lrn-kicker">Workers</p>
        <div className="segmented" role="tablist" aria-label="Roster filter">
          {segments.map((s) => (
            <button key={s.key} type="button" role="tab" aria-selected={filter === s.key}
                    className={filter === s.key ? 'on' : ''} onClick={() => onFilter(s.key)}>
              {s.label}{' '}<span className="lrn-count">{counts[s.key].toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Search workers…" aria-label="Search workers" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          {rows && <span className="result-count">{visible.length} of {rows.length} shown</span>}
          {canChange && (
            <button type="button" className="mini-btn" disabled={selected.length === 0 || busyId !== null}
                    onClick={() => onResend(selected)}>
              {selected.length > 0 ? `Resend to selected (${selected.length})` : 'Resend to selected'}
            </button>
          )}
        </div>
      </div>

      {failed && (
        <p className="pf-error" role="alert">
          Couldn’t load the workers.{' '}
          <button type="button" className="mini-btn" onClick={onRetry}>Try again</button>
        </p>
      )}
      {rows === null && !failed && <p className="page-hint">Loading…</p>}

      {rows !== null && (
        <div className={`dir-list list-scroll${loading ? ' lrn-stale' : ''}`} role="group" aria-label="Worker progress">
          <div className="list-head" style={rowStyle}>
            {canChange && (
              <span className="col-head">
                <input type="checkbox" checked={allTicked} disabled={visible.length === 0}
                       aria-label="Select all workers shown" onChange={toggleAll} />
              </span>
            )}
            {ROSTER_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
            {hasMenu && <span className="col-head" aria-hidden="true" />}
          </div>
          {visible.length === 0 && (
            <div className="dir-empty">
              {rows.length === 0
                ? <><b>{filter === 'all' ? 'No workers yet' : 'Nobody here'}</b>
                  {filter === 'all' ? 'People appear once they’re added to this initiative.' : 'No one has this status right now.'}</>
                : <><b>No matches</b>Try a different search.</>}
            </div>
          )}
          {visible.map((r) => {
            const chip = STATUS_CHIP[r.status];
            const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
            const actions = actionsFor(r);
            return (
              <div key={r.person_id} className="dir-row" style={{ minWidth: rowStyle.minWidth } as CSSProperties}>
                <div className="row-main" style={rowStyle}>
                  {canChange && (
                    <div className="cell">
                      <input type="checkbox" checked={picked.has(r.person_id)}
                             aria-label={`Select ${r.name}`} onChange={() => toggle(r.person_id)} />
                    </div>
                  )}
                  <div className="cell">
                    <span className="lrn-roster-name cell-top cell-line" title={r.name}>{r.name}</span>
                    <span className="cell-sub cell-line" title={r.email ?? undefined}>{r.email ?? 'No email on file'}</span>
                  </div>
                  <div className="cell"><span className="cell-sub cell-line" title={r.partner ?? undefined}>{r.partner ?? '—'}</span></div>
                  <div className="cell"><span className="cell-sub">{languageName(r.language)}</span></div>
                  <div className="cell">
                    <div className="lrn-prog">
                      <div className="lrn-funnel" role="img" aria-label={`${r.done} of ${r.total} signed`}>
                        <span style={{
                          width: `${pct}%`,
                          '--lrn-bar': r.status === 'complete' ? 'var(--c-green)' : 'var(--amber)',
                        } as CSSProperties} />
                      </div>
                      <span className="mono">{r.done}/{r.total}</span>
                    </div>
                  </div>
                  <div className="cell"><span className={`chip ${chip.cls}`}>{chip.label}</span></div>
                  <div className="cell">
                    <span className="cell-sub cell-line" title={fullDateTime(r.last_activity)}>
                      {r.last_activity ? relativeTime(r.last_activity) : '—'}
                    </span>
                  </div>
                  {hasMenu && (
                    <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RowActionsMenu actions={actions} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
