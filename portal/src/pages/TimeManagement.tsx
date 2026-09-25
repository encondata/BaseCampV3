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
  useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import { RowActionsMenu, type RowAction } from '../components/hardware/RowActionsMenu';
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
  listInitiatives,
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
  applyColumnOrder, ColHead, ColumnsButton, ExportButton, exportCsv, listGridStyle, listScale,
  moveKey, titleFor, useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
import { naturalCompare } from '../lib/sites';
import { elapsedSince, formatMinutes } from '../lib/timeFormat';
import {
  hasFilter, listQuery, NO_FILTER, timeSourceLabel, type TimesheetFilter,
} from '../lib/timeBulk';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/time.css';

const MISSED_PUNCH_MINUTES = 720; // 12h

// Fit: default columns + trailing ≤ LIST_FIT.page
// (1172px — .portal-page at a 1512px window, nav expanded).
const TIMESHEET_COLUMNS: ColumnDef[] = [
  { key: 'person', label: 'Person', width: '1.2fr', default: true, min: 140 },
  { key: 'date', label: 'Date', width: '0.9fr', default: true, min: 96 },
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
    case 'source': return timeSourceLabel(e.source);
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
  const { can, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
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
  // Declared here (rather than down with the rest of the timesheet-list
  // state) because the load effects below need it to refetch on pill change.
  const [statusPill, setStatusPill] = useState('all');
  // Server-side filters (person / job / site / clock-in days). Declared up
  // here with statusPill for the same reason: the load effect's deps read it.
  // They also scope "Approve all pending in this view".
  const [serverFilter, setServerFilter] = useState<TimesheetFilter>(NO_FILTER);
  const [jobOptions, setJobOptions] = useState<PunchOption[]>([]);
  const listSeq = useRef(0);

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
  // A specific status pill filters server-side (refetch on pill change) so
  // the 500-row cap applies per-status instead of truncating the whole
  // timesheet before the pill even gets a look; 'All' fetches unfiltered
  // and relies on the client-side pill/column/search filtering below. The
  // person / job / site / day filters always apply server-side. A newer
  // load wins over an older one that answers late.
  const loadTimesheet = async (status: string, scope: TimesheetFilter) => {
    const mine = ++listSeq.current;
    try {
      const rows = await listTimeEntries(listQuery(status, scope));
      if (mine !== listSeq.current) return;
      setTimesheet(rows);
      setTimesheetError('');
    } catch (err) {
      if (mine !== listSeq.current) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  useEffect(() => {
    if (!canView) return;
    void loadTimesheet(statusPill, serverFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, statusPill, serverFilter]);

  // The Person filter needs the worker list too, not only Add entry.
  useEffect(() => {
    if (!canView && !canAdd) return;
    void listWorkerOptions().then(setWorkers).catch(() => {});
  }, [canView, canAdd]);

  // Job filter: every non-archived job (punch options only carry open
  // ones); falls back to the punch options when the list cannot load.
  useEffect(() => {
    if (!canView) return;
    listInitiatives()
      .then((all) => setJobOptions(all.filter((j) => !j.archived_at)
        .map((j) => ({ id: j.id, name: j.name }))))
      .catch(() => setJobOptions([]));
  }, [canView]);

  const refreshAll = async () => {
    await loadMyTime();
    if (canView) {
      await loadActive();
      await loadTimesheet(statusPill, serverFilter);
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
  // The trailing track holds one RowActionsMenu trigger instead of the old
  // Approve + Reject + Edit strip; 88px is the width the other converted
  // lists give that trigger (Warehouse.tsx, InitiativeDetail.tsx).
  const grid = listGridStyle(shownCols, canChange ? ['88px'] : [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

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
          : <span className="cell-top cell-line">No</span>;
      case 'duration': {
        const text = formatMinutes(e.minutes);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'break': {
        const text = formatMinutes(e.break_minutes);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'clock_in': {
        const text = fmtTime(e.clock_in_at);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'clock_out': {
        const text = fmtTime(e.clock_out_at);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'date': {
        const text = fmtDate(e.clock_in_at);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'source': {
        const text = timeSourceLabel(e.source);
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      default: {
        const text = timeEntryCellText(e, key) || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
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
          <div className="mini-list time-recent-list">
            {myTime.entries.slice(0, 8).map((e) => (
              <div key={e.id} className="mini-row time-recent-row">
                <span className="mono">{fmtDate(e.clock_in_at)}</span>
                <span className="mono">{fmtTime(e.clock_in_at)} → {fmtTime(e.clock_out_at)}</span>
                <span className="mono">{formatMinutes(e.minutes)}</span>
                <span className="cell-sub">{e.initiative_name ?? '—'}</span>
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
            <div className="mini-list time-active-list">
              {activeEntries.map((e) => {
                const mins = elapsedSince(e.clock_in_at);
                return (
                  <div key={e.id} className="mini-row time-active-row">
                    <div className="cell-primary"><div className="pn"><b>{e.person_name}</b></div></div>
                    <span className="mono">since {fmtTime(e.clock_in_at)}</span>
                    <span className="mono">{formatMinutes(mins)}</span>
                    <span className="cell-sub">{e.initiative_name ?? '—'}</span>
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

          <div className="dir-toolbar audit-toolbar time-filters" role="group"
               aria-label="Timesheet filters">
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Person" placeholder="Any person…" clearable
                        value={serverFilter.person_id}
                        options={workers.map((w) => ({ value: w.person_id, label: w.display_name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, person_id: v }))} />
            </div>
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Job" placeholder="Any job…" clearable
                        value={serverFilter.initiative_id}
                        options={(jobOptions.length ? jobOptions : punchOptions.initiatives)
                          .map((j) => ({ value: j.id, label: j.name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, initiative_id: v }))} />
            </div>
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Site" placeholder="Any site…" clearable
                        value={serverFilter.site_id}
                        options={punchOptions.sites.map((s) => ({ value: s.id, label: s.name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, site_id: v }))} />
            </div>
            <input type="date" aria-label="From date" value={serverFilter.from}
                   onChange={(e) => setServerFilter((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" aria-label="To date" value={serverFilter.to}
                   onChange={(e) => setServerFilter((f) => ({ ...f, to: e.target.value }))} />
            {hasFilter(serverFilter) && (
              <button type="button" className="mini-btn" onClick={() => setServerFilter(NO_FILTER)}>
                Clear filters
              </button>
            )}
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

          {!timesheetError && timesheet !== null && timesheet.length === 500 && (
            <p className="page-hint">
              Showing the newest 500 entries — use filters to narrow.
            </p>
          )}

          {!timesheetError && (
            <div className="dir-list list-scroll">
              <div className="list-head" style={rowStyle}>
                {shownCols.map((c) => (
                  <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                           onToggleSort={() => toggleSort(c.key)}
                           className={headerDrag.dropClass(c.key)}
                           dragProps={headerDrag.dragProps(c.key)}>
                    <ColumnMenu colKey={c.key} label={c.label}
                                allRows={timesheet ?? []} filters={filters}
                                text={timeEntryCellText}
                                filter={filters[c.key]} onFilter={setFilter}
                                sortDir={sortKey === c.key ? sortDir : null}
                                onSort={(dir) => setSort(c.key, dir)} />
                  </ColHead>
                ))}
                {canChange && <span className="col-head" aria-hidden="true" />}
              </div>

              {timesheet && visibleEntries.length === 0 && (
                <div className="dir-empty">
                  <b>No matches</b>Try a different search or filter.
                  <EmptyClearFilters filters={filters} onClear={clearFilters} />
                </div>
              )}

              <VirtualRows rows={visibleEntries}
                renderRow={(e, vp) => (
                  <div key={e.id} className="dir-row" {...vp}
                       style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                    <div className="row-main time-row-static" style={rowStyle}>
                      {shownCols.map((c) => (
                        <div className="cell" key={c.key}>{cellFor(e, c.key)}</div>
                      ))}
                      {canChange && (
                        // Approve/Reject are BUILT only for a pending entry
                        // rather than disabled on a settled one: they are not
                        // momentarily unavailable, they do not apply at all.
                        // `disabled` is reserved for the in-flight row.
                        // `.row-main` here is `time-row-static` — no click
                        // handler — so no stopPropagation wrapper is needed.
                        <div className="cell time-row-actions">
                          <RowActionsMenu actions={[
                            ...(e.status === 'pending' ? [
                              {
                                key: 'approve', label: 'Approve',
                                disabled: rowBusyId === e.id,
                                onSelect: () => void doApproveRow(e.id),
                              },
                              {
                                key: 'reject', label: 'Reject', destructive: true,
                                disabled: rowBusyId === e.id,
                                onSelect: () => setModal({ entry: e, mode: 'reject' }),
                              },
                            ] : []),
                            {
                              key: 'edit', label: 'Edit',
                              disabled: rowBusyId === e.id,
                              onSelect: () => setModal({ entry: e, mode: 'edit' }),
                            },
                          ] satisfies RowAction[]} />
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
