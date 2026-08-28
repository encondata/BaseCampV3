/**
 * Time Management — punch clock, timesheet approvals, and per-initiative
 * time summaries. Five stacked sections:
 *   1. Timeclock card — everyone; self-service clock-in/out (no resource
 *      gate on the API side, so it renders regardless of `can('time')`).
 *   2. My recent entries — everyone; the caller's own last few punches.
 *   3. On the clock now — `can('time')`; who's currently clocked in.
 *   4. Timesheet — `can('time')`; the full directory-list of entries with
 *      approve/reject/edit.
 * TimeEntryEditModal (components/time/) is both the create-entry form and
 * the approve/reject surface for a pending row.
 */

import {
  useEffect, useMemo, useState, type CSSProperties,
} from 'react';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import StatusHover from '../components/StatusHover';
import TimeEntryEditModal, { mapTimeError } from '../components/time/TimeEntryEditModal';
import {
  ApiError,
  approveTimeEntry,
  clockIn as clockInRequest,
  clockOut as clockOutRequest,
  getMyTime,
  getPunchOptions,
  listActiveTimeEntries,
  listTimeEntries,
  listWorkerOptions,
  type PunchOption,
  type TimeEntryItem,
  type WorkerOption,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  applyColumnOrder, ColumnsButton, ExportButton, exportCsv, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
import { elapsedSince, formatMinutes } from '../lib/timeFormat';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/time.css';

const MISSED_PUNCH_MINUTES = 720; // 12h

const TIMESHEET_COLUMNS: ColumnDef[] = [
  { key: 'person', label: 'Person', width: '1.2fr', default: true },
  { key: 'date', label: 'Date', width: '0.9fr', default: true },
  { key: 'clock_in', label: 'Clock in', width: '0.8fr', default: true },
  { key: 'clock_out', label: 'Clock out', width: '0.8fr', default: true },
  { key: 'duration', label: 'Duration', width: '0.7fr', default: true },
  { key: 'break', label: 'Break', width: '0.6fr', default: false },
  { key: 'initiative', label: 'Initiative', width: '1.1fr', default: true },
  { key: 'site', label: 'Site', width: '1fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
  { key: 'adjusted', label: 'Adjusted', width: '0.7fr', default: false },
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'approved_by', label: 'Approved by', width: '1fr', default: false },
  { key: 'notes', label: 'Notes', width: '1.2fr', default: false },
];
const ALL_COLUMN_KEYS = new Set<string>(TIMESHEET_COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(TIMESHEET_COLUMNS.filter((c) => c.default).map((c) => c.key));

const STATUS_PILLS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function timeEntryCellText(e: TimeEntryItem, key: string): string {
  switch (key) {
    case 'person': return e.person_name;
    case 'date': return fmtDate(e.clock_in_at);
    case 'clock_in': return fmtTime(e.clock_in_at);
    case 'clock_out': return fmtTime(e.clock_out_at);
    case 'duration': return formatMinutes(e.minutes);
    case 'break': return formatMinutes(e.break_minutes);
    case 'initiative': return e.initiative_name ?? '';
    case 'site': return e.site_name ?? '';
    case 'source': return e.source;
    case 'adjusted': return e.adjusted ? 'Yes' : 'No';
    case 'status': return e.status_label;
    case 'approved_by': return e.approved_by_name ?? '';
    case 'notes': return e.notes;
    default: return '';
  }
}

const CSV_COLUMNS: [string, (e: TimeEntryItem) => string][] =
  TIMESHEET_COLUMNS.map((c) => [c.label, (e: TimeEntryItem) => timeEntryCellText(e, c.key)]);

function statusChip(label: string, color: string) {
  return (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  );
}

export default function TimeManagement() {
  const { can } = useAuth();
  const canView = can('time');
  const canAdd = can('time', 'add');
  const canChange = can('time', 'change');

  const [myTime, setMyTime] = useState<{ open: TimeEntryItem | null; entries: TimeEntryItem[] } | null>(null);
  const [punchOptions, setPunchOptions] = useState<{ initiatives: PunchOption[]; sites: PunchOption[] }>(
    { initiatives: [], sites: [] },
  );
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [activeEntries, setActiveEntries] = useState<TimeEntryItem[] | null>(null);
  const [timesheet, setTimesheet] = useState<TimeEntryItem[] | null>(null);
  const [timesheetError, setTimesheetError] = useState('');

  // ── live elapsed ticking (block 1's open span, block 3's since-times) ──
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadMyTime = async () => {
    try {
      setMyTime(await getMyTime());
    } catch {
      setMyTime({ open: null, entries: [] });
    }
  };
  const loadActive = async () => {
    try {
      setActiveEntries(await listActiveTimeEntries());
    } catch {
      setActiveEntries([]);
    }
  };
  const loadTimesheet = async () => {
    try {
      setTimesheet(await listTimeEntries({}));
      setTimesheetError('');
    } catch (err) {
      setTimesheet([]);
      setTimesheetError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view the timesheet.' : 'Failed to load time entries.');
    }
  };

  useEffect(() => {
    void loadMyTime();
    void getPunchOptions().then(setPunchOptions).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canView) return;
    void loadActive();
    void loadTimesheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  useEffect(() => {
    if (!canAdd) return;
    void listWorkerOptions().then(setWorkers).catch(() => {});
  }, [canAdd]);

  const refreshAll = async () => {
    await loadMyTime();
    if (canView) {
      await loadActive();
      await loadTimesheet();
    }
  };

  /* ── block 1: timeclock ──────────────────────────────────── */

  const [inInitiativeId, setInInitiativeId] = useState('');
  const [inSiteId, setInSiteId] = useState('');
  const [inNotes, setInNotes] = useState('');
  const [outNotes, setOutNotes] = useState('');
  const [outBreak, setOutBreak] = useState('');
  const [punchBusy, setPunchBusy] = useState(false);
  const [punchError, setPunchError] = useState('');

  const doClockIn = async () => {
    setPunchBusy(true);
    setPunchError('');
    try {
      await clockInRequest({
        initiative_id: inInitiativeId || undefined,
        site_id: inSiteId || undefined,
        notes: inNotes.trim() || undefined,
      });
      setInInitiativeId('');
      setInSiteId('');
      setInNotes('');
      await refreshAll();
    } catch (err) {
      setPunchError(mapTimeError(err, 'Could not clock in — try again.'));
    } finally {
      setPunchBusy(false);
    }
  };

  const doClockOut = async () => {
    setPunchBusy(true);
    setPunchError('');
    try {
      await clockOutRequest({
        notes: outNotes.trim() || undefined,
        break_minutes: outBreak.trim() ? Number(outBreak) : undefined,
      });
      setOutNotes('');
      setOutBreak('');
      await refreshAll();
    } catch (err) {
      setPunchError(mapTimeError(err, 'Could not clock out — try again.'));
    } finally {
      setPunchBusy(false);
    }
  };

  const open = myTime?.open ?? null;
  const openElapsed = open ? formatMinutes(elapsedSince(open.clock_in_at)) : '';

  /* ── block 4: timesheet list machinery ───────────────────── */

  const [query, setQuery] = useState('');
  const [statusPill, setStatusPill] = useState('all');
  const [modal, setModal] = useState<{ entry: TimeEntryItem | null; mode: 'edit' | 'reject' } | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  // A single row action failing (e.g. a 409 from someone else approving the
  // same entry first) must never blank the whole loaded list — that's what
  // `timesheetError` is for (the INITIAL load failing). This stays separate
  // and renders as its own dismissible line above the list.
  const [actionError, setActionError] = useState('');

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'time_entries', { visible: DEFAULT_VISIBLE, sortKey: 'date', sortDir: -1 }, ALL_COLUMN_KEYS,
  );

  const orderedCols = applyColumnOrder(TIMESHEET_COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = {
    gridTemplateColumns: shownCols.map((c) => c.width).join(' ') + (canChange ? ' 210px' : ''),
  };

  const haystack = useSearchHaystacks(timesheet, (e: TimeEntryItem) =>
    TIMESHEET_COLUMNS.map((c) => timeEntryCellText(e, c.key)).join(' ').toLowerCase());

  const visibleEntries = useMemo(() => {
    const rows = timesheet ?? [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((e) => {
      if (statusPill !== 'all' && e.status !== statusPill) return false;
      if (!passesColumnFilters(e, filters, timeEntryCellText)) return false;
      if (!q) return true;
      return haystack(e).includes(q);
    });
    return filtered.sort((a, b) => {
      // Date/Clock in/Clock out sort by the real instant, not the locale
      // text — see MoveDashboard's identical rationale.
      if (sortKey === 'date' || sortKey === 'clock_in') {
        return (Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at)) * sortDir;
      }
      if (sortKey === 'clock_out') {
        const av = a.clock_out_at ? Date.parse(a.clock_out_at) : Infinity;
        const bv = b.clock_out_at ? Date.parse(b.clock_out_at) : Infinity;
        return (av - bv) * sortDir;
      }
      return naturalCompare(timeEntryCellText(a, sortKey), timeEntryCellText(b, sortKey)) * sortDir;
    });
  }, [timesheet, filters, query, statusPill, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const doApproveRow = async (id: string) => {
    setRowBusyId(id);
    setActionError('');
    try {
      await approveTimeEntry(id);
      await refreshAll();
    } catch (err) {
      setActionError(mapTimeError(err, 'Could not approve — try again.'));
    } finally {
      setRowBusyId(null);
    }
  };

  const cellFor = (e: TimeEntryItem, key: string) => {
    switch (key) {
      case 'status':
        return (
          <StatusHover entityType="time_entry" entityId={e.id} status={e.status}>
            {statusChip(e.status_label, e.status_color)}
          </StatusHover>
        );
      case 'adjusted':
        return e.adjusted
          ? statusChip('Yes', '#a36207')
          : <span className="cell-top">No</span>;
      case 'duration':
        return <span className="mono">{formatMinutes(e.minutes)}</span>;
      case 'break':
        return <span className="mono">{formatMinutes(e.break_minutes)}</span>;
      case 'clock_in':
        return <span className="mono">{fmtTime(e.clock_in_at)}</span>;
      case 'clock_out':
        return <span className="mono">{fmtTime(e.clock_out_at)}</span>;
      case 'date':
        return <span className="cell-top">{fmtDate(e.clock_in_at)}</span>;
      case 'source':
        return <span className="cell-top">{e.source.charAt(0).toUpperCase() + e.source.slice(1)}</span>;
      default:
        return <span className="cell-top">{timeEntryCellText(e, key) || '—'}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">People</div>
      <h1 className="page-title">Time Management</h1>
      <p className="page-hint">
        Clock in/out, review timesheets, and approve or reject entries.
      </p>

      {/* ── 1. Timeclock ─────────────────────────────────────── */}
      <section className="time-clock-card" aria-label="Timeclock">
        {open ? (
          <>
            <div className="time-clock-status">
              <span className="time-clock-eyebrow">Clocked in</span>
              <span className="time-clock-elapsed">{openElapsed}</span>
              <span className="time-clock-meta">
                {open.initiative_name ?? 'No initiative'} · {open.site_name ?? 'No site'}
              </span>
            </div>
            <div className="time-clock-form">
              <div className="time-field">
                <label htmlFor="tc-out-notes">Notes</label>
                <input id="tc-out-notes" value={outNotes} disabled={punchBusy}
                       onChange={(e) => setOutNotes(e.target.value)} />
              </div>
              <div className="time-field">
                <label htmlFor="tc-out-break">Break (minutes)</label>
                <input id="tc-out-break" type="number" min={0} value={outBreak} disabled={punchBusy}
                       onChange={(e) => setOutBreak(e.target.value)} />
              </div>
              <button className="btn-solid" disabled={punchBusy} onClick={() => void doClockOut()}>
                {punchBusy ? 'Working…' : 'Clock out'}
              </button>
            </div>
          </>
        ) : (
          <div className="time-clock-form">
            <div className="time-field">
              <label>Initiative (optional)</label>
              <ComboBox
                placeholder="Type to search initiatives…"
                value={inInitiativeId}
                clearable
                disabled={punchBusy}
                onChange={setInInitiativeId}
                options={punchOptions.initiatives.map((i) => ({ value: i.id, label: i.name }))}
              />
            </div>
            <div className="time-field">
              <label>Site (optional)</label>
              <ComboBox
                placeholder="Type to search sites…"
                value={inSiteId}
                clearable
                disabled={punchBusy}
                onChange={setInSiteId}
                options={punchOptions.sites.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
            <div className="time-field">
              <label htmlFor="tc-in-notes">Notes</label>
              <input id="tc-in-notes" value={inNotes} disabled={punchBusy}
                     onChange={(e) => setInNotes(e.target.value)} />
            </div>
            <button className="btn-solid" disabled={punchBusy} onClick={() => void doClockIn()}>
              {punchBusy ? 'Working…' : 'Clock in'}
            </button>
          </div>
        )}
        {punchError && <span className="pf-error">{punchError}</span>}
      </section>

      {/* ── 2. My recent entries ─────────────────────────────── */}
      <section className="time-panel" aria-label="My recent entries">
        <div className="time-panel-head"><span className="time-panel-title">My recent entries</span></div>
        {myTime === null && <div className="time-panel-empty">Loading…</div>}
        {myTime !== null && myTime.entries.length === 0 && (
          <div className="time-panel-empty">No entries yet.</div>
        )}
        {myTime !== null && myTime.entries.length > 0 && (
          <div className="time-recent-list">
            {myTime.entries.slice(0, 8).map((e) => (
              <div key={e.id} className="time-recent-row">
                <span className="time-recent-date">{fmtDate(e.clock_in_at)}</span>
                <span className="time-recent-span">{fmtTime(e.clock_in_at)} → {fmtTime(e.clock_out_at)}</span>
                <span className="time-recent-duration">{formatMinutes(e.minutes)}</span>
                <span className="time-recent-initiative">{e.initiative_name ?? '—'}</span>
                <StatusHover entityType="time_entry" entityId={e.id} status={e.status}>
                  {statusChip(e.status_label, e.status_color)}
                </StatusHover>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 3. On the clock now ──────────────────────────────── */}
      {canView && (
        <section className="time-panel" aria-label="On the clock now">
          <div className="time-panel-head"><span className="time-panel-title">On the clock now</span></div>
          {activeEntries === null && <div className="time-panel-empty">Loading…</div>}
          {activeEntries !== null && activeEntries.length === 0 && (
            <div className="time-panel-empty">No one is clocked in right now.</div>
          )}
          {activeEntries !== null && activeEntries.length > 0 && (
            <div className="time-active-list">
              {activeEntries.map((e) => {
                const mins = elapsedSince(e.clock_in_at);
                return (
                  <div key={e.id} className="time-active-row">
                    <span className="time-active-person">{e.person_name}</span>
                    <span className="time-active-since">since {fmtTime(e.clock_in_at)}</span>
                    <span className="time-active-elapsed">{formatMinutes(mins)}</span>
                    <span className="time-active-initiative">{e.initiative_name ?? '—'}</span>
                    {mins > MISSED_PUNCH_MINUTES && (
                      <span className="chip tag time-flag">12h+ — missed punch?</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── 4. Timesheet ──────────────────────────────────────── */}
      {canView && (
        <section className="time-timesheet" aria-label="Timesheet">
          <div className="dir-head">
            <h2 className="time-section-title">Timesheet</h2>
          </div>
          <div className="dir-toolbar">
            <div className="segmented" role="tablist">
              {STATUS_PILLS.map((p) => (
                <button key={p.key} role="tab" aria-selected={statusPill === p.key}
                        className={statusPill === p.key ? 'on' : ''}
                        onClick={() => setStatusPill(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="toolbar-right">
              <div className="dir-search" style={{ marginLeft: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input placeholder="Filter entries…" value={query}
                       onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span className="result-count">
                {visibleEntries.length} of {timesheet?.length ?? 0} shown
              </span>
              <FilterSummaryChip filters={filters} onClear={clearFilters} />
              <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                             onReorder={setColOrder} />
              <ExportButton onExport={() => exportCsv('time-entries', CSV_COLUMNS, visibleEntries)} />
              {canAdd && (
                <button className="btn-solid" onClick={() => setModal({ entry: null, mode: 'edit' })}>
                  + Add entry
                </button>
              )}
            </div>
          </div>

          {timesheetError && (
            <div className="dir-empty" style={{ marginBottom: 12 }}>
              <b>Cannot load timesheet</b>{timesheetError}
            </div>
          )}

          {!timesheetError && actionError && (
            <div className="time-action-error">
              <span className="pf-error">{actionError}</span>
              <button type="button" className="mini-btn sm" onClick={() => setActionError('')}>
                Dismiss
              </button>
            </div>
          )}

          {!timesheetError && (
            <div className="dir-list">
              <div className="list-head" style={grid}>
                {shownCols.map((c) => (
                  <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                        {...headerDrag.dragProps(c.key)}>
                    <button type="button" className="sortable" onClick={() => toggleSort(c.key)}>
                      {c.label} {caret(c.key)}
                    </button>
                    <ColumnMenu colKey={c.key} label={c.label}
                                allRows={timesheet ?? []} filters={filters}
                                text={timeEntryCellText}
                                filter={filters[c.key]} onFilter={setFilter}
                                sortDir={sortKey === c.key ? sortDir : null}
                                onSort={(dir) => setSort(c.key, dir)} />
                  </span>
                ))}
                {canChange && <span className="col-head" />}
              </div>

              {timesheet && visibleEntries.length === 0 && (
                <div className="dir-empty">
                  <b>No matches</b>Try a different search or filter.
                  <EmptyClearFilters filters={filters} onClear={clearFilters} />
                </div>
              )}

              <VirtualRows rows={visibleEntries}
                renderRow={(e, vp) => (
                  <div key={e.id} className="dir-row" {...vp} style={vp?.style}>
                    <div className="row-main time-row-static" style={grid}>
                      {shownCols.map((c) => (
                        <div className="cell" key={c.key}>{cellFor(e, c.key)}</div>
                      ))}
                      {canChange && (
                        <div className="cell time-row-actions">
                          {e.status === 'pending' && (
                            <button type="button" className="mini-btn sm"
                                    disabled={rowBusyId === e.id}
                                    onClick={() => void doApproveRow(e.id)}>
                              Approve
                            </button>
                          )}
                          {e.status === 'pending' && (
                            <button type="button" className="mini-btn sm danger"
                                    disabled={rowBusyId === e.id}
                                    onClick={() => setModal({ entry: e, mode: 'reject' })}>
                              Reject
                            </button>
                          )}
                          <button type="button" className="mini-btn sm"
                                  disabled={rowBusyId === e.id}
                                  onClick={() => setModal({ entry: e, mode: 'edit' })}>
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )} />
            </div>
          )}
        </section>
      )}

      {modal && (
        <TimeEntryEditModal
          entry={modal.entry}
          initialMode={modal.mode}
          initiatives={punchOptions.initiatives}
          sites={punchOptions.sites}
          workers={workers}
          canApprove={canChange}
          onClose={() => setModal(null)}
          onSaved={refreshAll}
        />
      )}
    </div>
  );
}
