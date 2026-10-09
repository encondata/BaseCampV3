/**
 * Developer › Database › Health — a read-mostly look at the database:
 * summary tiles, who is connected, per-table sizes and dead rows with a
 * Vacuum & analyze action, and an on-demand file-storage measurement.
 *
 * No polling. One Refresh reloads the summary, connections and tables
 * (each section keeps its own error, so one failure leaves the rest
 * readable). Storage is only measured when asked — it walks every stored
 * object. The API (routes/health.py, devtools/health.py) owns every rule;
 * this tab formats and sorts. The Connections tile is cluster-wide (every
 * database on the server) while the connections list is this database only,
 * and the copy says so.
 *
 * Vacuum replaces the row with the table the API returns rather than
 * reloading, so a long list does not jump. Failures show the API's
 * plain-English message (409 `testing_session_active` / `table_busy`).
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError,
  getHealthConnections,
  getHealthStorage,
  getHealthSummary,
  getHealthTables,
  vacuumHealthTable,
  type HealthConnectionGroup,
  type HealthStorageOut,
  type HealthSummary,
  type HealthTable,
} from '../../lib/api';
import {
  TABLE_COLUMNS, defaultSortDir, formatAge, formatBytes, formatLatency, formatPercent,
  formatUptime, formatVacuumTime, isStale, sortTables,
} from '../../lib/dbHealth';
import { relativeTime } from '../../lib/format';
import {
  ACTIONS_TRACK, ColHead, listGridStyle, listScale, titleFor, type ColumnDef,
} from '../../lib/listTools';
import '../../styles/directory.css';
import '../../styles/profile.css'; /* .btn-solid */
import '../../styles/initiatives.css'; /* .init-panel, .mini-btn */
import '../../styles/settings.css'; /* .set-ok */
import '../../styles/system.css'; /* .sysconf-card, .health-* */
import { RowActionsMenu } from '../hardware/RowActionsMenu';

const SUMMARY_ERROR = 'Could not load the summary — try again.';
const CONNECTIONS_ERROR = 'Could not load the connections — try again.';
const TABLES_ERROR = 'Could not load the tables — try again.';
const VACUUM_ERROR = 'The vacuum failed — try again.';
const STORAGE_ERROR = 'Could not measure file storage — try again.';

const count = (n: number) => n.toLocaleString();

/** The API's own plain-English message for a coded failure, else `fallback`. */
function apiMessage(err: unknown, codes: string[], fallback: string): string {
  if (err instanceof ApiError && codes.includes(err.code)) {
    const message = (err.detail as { message?: string } | undefined)?.message;
    if (message) return message;
  }
  return fallback;
}

/* ── a plain (unsorted) list on the shared list recipe ───────────── */

/** Connections and Storage both render through this: one header, one
 *  listGridStyle() call, px floors on every column, the sideways-scroll
 *  card. Cells come back as one node per column. */
function PlainList<T>({ cols, rows, rowKey, cells }: {
  cols: ColumnDef[];
  rows: T[];
  rowKey: (row: T) => string;
  cells: (row: T) => ReactNode[];
}) {
  const { preferences } = useAuth();
  const grid = listGridStyle(cols, [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  return (
    <div className="dir-list list-scroll">
      <div className="list-head" style={rowStyle}>
        {cols.map((c) => <ColHead key={c.key} col={c} />)}
      </div>
      {rows.map((r) => (
        <div key={rowKey(r)} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
          <div className="row-main" style={rowStyle}>
            {cells(r).map((node, i) => <div key={cols[i].key} className="cell">{node}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── summary ─────────────────────────────────────────────────────── */

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="health-tile">
      <span className="health-tile-label">{label}</span>
      <span className="health-tile-value">{value}</span>
      {sub && <span className="health-tile-sub">{sub}</span>}
    </div>
  );
}

function SummaryCard({ summary, error, loading, onRefresh }: {
  summary: HealthSummary | null; error: string; loading: boolean; onRefresh: () => void;
}) {
  const dash = '—';
  return (
    <section className="init-panel sysconf-card health-card" aria-label="Summary">
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">Summary</div>
        <p className="sysconf-card-desc">
          A snapshot taken when the page loaded or Refresh was last pressed.
        </p>
      </div>
      <div className="health-tiles">
        <Tile label="Database size" value={summary ? formatBytes(summary.database_size_bytes) : dash} />
        <Tile label="Postgres version" value={summary ? summary.version : dash} />
        <Tile label="Uptime" value={summary ? formatUptime(summary.started_at) : dash} />
        <Tile label="Response time" value={summary ? formatLatency(summary.latency_ms) : dash} />
        <Tile
          label="Connections"
          value={summary ? `${count(summary.connections)} of ${count(summary.max_connections)}` : dash}
          sub="across the whole database server"
        />
        <Tile label="Cache hit rate" value={summary ? formatPercent(summary.cache_hit_ratio) : dash} />
      </div>
      {error && <p className="pf-error">{error}</p>}
      <div className="health-actions">
        <button type="button" className="mini-btn" disabled={loading} onClick={onRefresh}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </section>
  );
}

/* ── connections ─────────────────────────────────────────────────── */

const CONNECTION_COLUMNS: ColumnDef[] = [
  { key: 'application_name', label: 'Application', width: '2fr', default: true, min: 160 },
  { key: 'state', label: 'State', width: '1.4fr', default: true, min: 140 },
  { key: 'count', label: 'Count', width: '0.6fr', default: true },
  { key: 'oldest_query', label: 'Oldest query', short: 'Query', width: '1fr', default: true, min: 96 },
  { key: 'oldest_transaction', label: 'Oldest transaction', short: 'Transaction', width: '1fr',
    default: true, min: 104 },
  { key: 'waiting', label: 'Waiting on a lock', short: 'Waiting', width: '1.4fr', default: true, min: 150 },
];

/** An age, as an amber chip when it has been open more than five minutes. */
function Age({ seconds }: { seconds: number | null }) {
  const text = formatAge(seconds);
  return isStale(seconds)
    ? <span className="chip c-amber" title="Open for more than 5 minutes">{text}</span>
    : <span className="mono cell-line">{text}</span>;
}

function ConnectionsCard({ groups, error }: {
  groups: HealthConnectionGroup[] | null; error: string;
}) {
  return (
    <section className="init-panel sysconf-card health-card" aria-label="Connections">
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">Connections</div>
        <p className="sysconf-card-desc">
          This database only, grouped by application and state. Amber means a query or
          transaction has been open more than 5 minutes.
        </p>
      </div>
      {error && <p className="pf-error">{error}</p>}
      {groups && groups.length === 0 && (
        <p className="page-hint health-none">No other connections right now.</p>
      )}
      {groups && groups.length > 0 && (
        <PlainList
          cols={CONNECTION_COLUMNS}
          rows={groups}
          rowKey={(g) => `${g.application_name}\u0000${g.state}`}
          cells={(g) => [
            <span key="app" className="cell-top cell-line" title={g.application_name}>
              {g.application_name}
            </span>,
            <span key="state" className="chip tag">{g.state || '—'}</span>,
            <span key="count" className="mono cell-line">{count(g.count)}</span>,
            <Age key="q" seconds={g.oldest_query_seconds} />,
            <Age key="t" seconds={g.oldest_transaction_seconds} />,
            g.waiting_on_lock > 0
              ? <span key="w" className="chip c-amber">{count(g.waiting_on_lock)} waiting on a lock</span>
              : <span key="w" className="mono cell-line">—</span>,
          ]}
        />
      )}
    </section>
  );
}

/* ── tables ──────────────────────────────────────────────────────── */

function TablesCard({ tables, error, canChange, onChanged }: {
  tables: HealthTable[] | null;
  error: string;
  canChange: boolean;
  /** the vacuumed table, as the API returned it */
  onChanged: (table: HealthTable) => void;
}) {
  const { preferences } = useAuth();
  const [sortKey, setSortKey] = useState('total_bytes');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [vacuumError, setVacuumError] = useState('');

  const grid = listGridStyle(TABLE_COLUMNS, [ACTIONS_TRACK], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  const sorted = tables ? sortTables(tables, sortKey, sortDir) : [];

  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(defaultSortDir(key));
    }
  };

  const vacuum = async (t: HealthTable) => {
    if (!confirm(`Vacuum and analyze "${t.name}"? This reclaims space from dead rows and `
      + 'refreshes the statistics the query planner uses. The table stays readable and '
      + 'writable while it runs, but a large table can take a while.')) return;
    setBusy(t.name);
    setNote('');
    setVacuumError('');
    try {
      const out = await vacuumHealthTable(t.name);
      onChanged(out.table);
      setNote(`${out.table.name}: Vacuumed in ${formatVacuumTime(out.duration_ms)}`);
    } catch (err) {
      setVacuumError(apiMessage(err, ['testing_session_active', 'table_busy', 'unknown_table'],
        VACUUM_ERROR));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="init-panel sysconf-card health-card" aria-label="Tables">
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">Tables</div>
        <p className="sysconf-card-desc">
          Sizes and dead rows for every table. Dead rows are old row versions waiting to be
          reclaimed; a high share means a vacuum is overdue.
        </p>
      </div>
      {error && <p className="pf-error">{error}</p>}
      {vacuumError && <p className="pf-error">{vacuumError}</p>}
      {note && <p className="set-ok">{note}</p>}
      {tables && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {TABLE_COLUMNS.map((c) => (
              <ColHead
                key={c.key}
                col={c}
                sortDir={sortKey === c.key ? sortDir : null}
                onToggleSort={() => toggleSort(c.key)}
              />
            ))}
            <span className="col-head" aria-hidden="true" />
          </div>
          {sorted.map((t) => (
            <div key={t.name} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
              <div className="row-main" style={rowStyle}>
                <div className="cell">
                  <span className="cell-top cell-line" title={titleFor(t.name)}>{t.name}</span>
                </div>
                <div className="cell"><span className="mono cell-line">{count(t.rows)}</span></div>
                <div className="cell"><span className="mono cell-line">{formatBytes(t.total_bytes)}</span></div>
                <div className="cell"><span className="mono cell-line">{formatBytes(t.table_bytes)}</span></div>
                <div className="cell"><span className="mono cell-line">{formatBytes(t.index_bytes)}</span></div>
                <div className="cell">
                  <span className="mono cell-line">
                    {t.dead_ratio === null
                      ? count(t.dead_rows)
                      : `${count(t.dead_rows)} · ${formatPercent(t.dead_ratio)}`}
                  </span>
                </div>
                <div className="cell">
                  <span className="mono cell-line" title={t.last_vacuum_at ?? undefined}>
                    {relativeTime(t.last_vacuum_at)}
                  </span>
                </div>
                <div className="cell">
                  <span className="mono cell-line" title={t.last_analyze_at ?? undefined}>
                    {relativeTime(t.last_analyze_at)}
                  </span>
                </div>
                <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {canChange && (
                    <RowActionsMenu actions={[{
                      key: 'vacuum',
                      label: 'Vacuum & analyze',
                      onSelect: () => void vacuum(t),
                      disabled: busy !== null,
                    }]} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── file storage ────────────────────────────────────────────────── */

const STORAGE_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Folder', width: '2fr', default: true, min: 160 },
  { key: 'objects', label: 'Objects', width: '1fr', default: true, min: 96 },
  { key: 'bytes', label: 'Size', width: '1fr', default: true, min: 96 },
];

function StorageCard() {
  const [data, setData] = useState<HealthStorageOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const measure = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getHealthStorage());
    } catch (err) {
      setError(apiMessage(err, ['storage_unavailable'], STORAGE_ERROR));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="init-panel sysconf-card health-card" aria-label="File storage">
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">File storage</div>
        <p className="sysconf-card-desc">
          Uploaded files by top-level folder. Measuring reads the whole bucket listing, so it
          runs only when you ask and can take a moment.
        </p>
      </div>
      <div className="health-actions">
        <button type="button" className="mini-btn" disabled={loading} onClick={() => void measure()}>
          {loading ? 'Measuring…' : data ? 'Measure again' : 'Measure storage'}
        </button>
      </div>
      {error && <p className="pf-error">{error}</p>}
      {data && (
        <>
          <PlainList
            cols={STORAGE_COLUMNS}
            rows={data.folders}
            rowKey={(f) => f.name}
            cells={(f) => [
              <span key="n" className="cell-top cell-line" title={f.name}>{f.name}</span>,
              <span key="o" className="mono cell-line">{count(f.objects)}</span>,
              <span key="b" className="mono cell-line">{formatBytes(f.bytes)}</span>,
            ]}
          />
          <p className="page-hint health-none">
            Total: {count(data.total_objects)} {data.total_objects === 1 ? 'object' : 'objects'}
            {' · '}{formatBytes(data.total_bytes)}
          </p>
          <p className="page-hint health-none">
            Measured at {new Date(data.measured_at).toLocaleString()}
          </p>
        </>
      )}
    </section>
  );
}

/* ── the tab ─────────────────────────────────────────────────────── */

export default function HealthTab() {
  const { can } = useAuth();
  const canChange = can('devtools', 'change');

  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [groups, setGroups] = useState<HealthConnectionGroup[] | null>(null);
  const [tables, setTables] = useState<HealthTable[] | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [connectionsError, setConnectionsError] = useState('');
  const [tablesError, setTablesError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const [s, c, t] = await Promise.allSettled([
      getHealthSummary(), getHealthConnections(), getHealthTables(),
    ]);
    if (s.status === 'fulfilled') { setSummary(s.value); setSummaryError(''); }
    else setSummaryError(SUMMARY_ERROR);
    if (c.status === 'fulfilled') { setGroups(c.value.groups); setConnectionsError(''); }
    else setConnectionsError(CONNECTIONS_ERROR);
    if (t.status === 'fulfilled') { setTables(t.value.tables); setTablesError(''); }
    else setTablesError(TABLES_ERROR);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  return (
    <>
      <SummaryCard summary={summary} error={summaryError} loading={loading}
                   onRefresh={() => void load()} />
      <ConnectionsCard groups={groups} error={connectionsError} />
      <TablesCard
        tables={tables}
        error={tablesError}
        canChange={canChange}
        onChanged={(next) => setTables((prev) =>
          prev && prev.map((t) => (t.name === next.name ? next : t)))}
      />
      <StorageCard />
    </>
  );
}
