/**
 * Developer → Database → Testing — password-gated "DB testing mode":
 * snapshot the whole database, make changes freely while testing, then
 * either keep them or revert straight back to the snapshot. Rendered
 * only while god mode is unlocked (DevDatabase.tsx just swaps this tab
 * in — the lock itself lives here, since the tab is meaningless without
 * it). See docs/superpowers/specs/2026-09-12-db-testing-mode-design.md
 * § Portal/API for the full contract this mirrors.
 *
 * Status card: Idle / Snapshotting… / Testing mode ON (with live
 * "Changes" deltas, polled every 5 s) / Reverting… / Failed (with the
 * read-only hint — a failed revert leaves the database read-only on
 * purpose, so the tab points at Settings › Maintenance instead of
 * pretending it can fix itself).
 *
 * `GET .../status` only ever puts an UNFINISHED session (snapshotting/
 * active/reverting) in `session` — a `failed` one lands in `recent`
 * instead (devtools.py's status read). So a failure is read from
 * `recent[0]` whenever there's no live session, and the read-only hint
 * only shows when the portal is actually read-only right now
 * (`useSystemStatus()` — a failed *snapshot*, as opposed to a failed
 * revert, never sets it).
 *
 * The revert confirmation follows the roomy modal header pattern
 * (rgm-head-text — see GenerateReportModal, BulkContainersModal,
 * LabelRunErrorsModal) — Jimmy's standing rule for every modal — but
 * skips GenerateReportModal's `rgm-card` width modifier so the card
 * sizes to its one-field content instead of stretching to 980px.
 */

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError,
  endDbTesting,
  getDbTestingStatus,
  startDbTesting,
  type DbTestingChanges,
  type DbTestingSession,
  type DbTestingSessionStatus,
  type DbTestingStatusOut,
} from '../../lib/api';
import { longDate } from '../../lib/format';
import { ColHead, listGridStyle, listScale, type ColumnDef } from '../../lib/listTools';
import { useSystemStatus } from '../../lib/systemStatusContext';
import '../../styles/directory.css'; /* .dir-list, .dir-row, .dir-empty */
import '../../styles/profile.css'; /* .pf-form, .pf-error, .pf-notice, .btn-solid */
import '../../styles/initiatives.css'; /* .init-panel */
import '../../styles/system.css'; /* .eyebrow-sm, .sysconf-card, .sysconf-row/-field/-label */
import '../../styles/reports.css'; /* .rgm-head-text (roomy modal header), .report-progress .spinner */

const POLL_MS = 5000;
// While idle with the worker offline, poll more slowly than the live-session
// 5s rate just so the chip (and Start) recover on their own once the worker
// comes back, without requiring a remount.
const IDLE_WORKER_POLL_MS = 15_000;
const LIVE_STATUSES: DbTestingSessionStatus[] = ['snapshotting', 'active', 'reverting'];

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). Read-only, unsortable list —
// headers render as plain ColHead spans (no onToggleSort). No trailing
// track — every column is a data column, no chevron/actions cell.
// Fit: default columns ≤ 1176px (.portal-page at a 1512px window, nav
// expanded — DbTestingTab sits directly in .portal-page under
// DevDatabase's tab bar, with no extra card).
const RECENT_COLUMNS: ColumnDef[] = [
  { key: 'started', label: 'Started', width: '1.3fr', default: true, min: 96 },
  { key: 'by', label: 'By', width: '1.1fr', default: true },
  { key: 'ended', label: 'Ended', width: '1.3fr', default: true, min: 96 },
  { key: 'outcome', label: 'Outcome', width: '100px', default: true },
  { key: 'snapshot', label: 'Snapshot', width: '1.6fr', default: true, min: 120 },
  { key: 'changes', label: 'Changes', width: '1fr', default: true },
];

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

const ERROR_COPY: Record<string, string> = {
  invalid_testing_password: 'That is not the testing password.',
  too_many_attempts: 'Too many attempts — wait a bit before trying again.',
  session_active: 'A testing session is already running.',
  worker_offline: 'The database-testing worker is offline.',
  session_not_active: 'There is no active testing session to end.',
};

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return ERROR_COPY[err.code] ?? 'Something went wrong — try again.';
  return 'Network error — try again.';
}

function outcomeChip(session: DbTestingSession): { cls: string; label: string } {
  if (session.status === 'failed') return { cls: 'chip c-red', label: 'Failed' };
  if (session.ended_with === 'reverted') return { cls: 'chip c-slate', label: 'Reverted' };
  if (session.ended_with === 'kept') return { cls: 'chip c-green', label: 'Kept' };
  return { cls: 'chip', label: '—' };
}

function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** "N audited changes · containers +15, generated_labels +185" — the
 *  compact live delta list from the spec. Only tables with a non-zero
 *  delta are sent by the API, so nothing here is a "no change" row. */
function ChangesSummary({ changes }: { changes: DbTestingChanges | null }) {
  if (!changes) return null;
  return (
    <p className="page-hint" style={{ marginTop: 8, marginBottom: 0 }}>
      {changes.audit_rows} audited change{changes.audit_rows === 1 ? '' : 's'}
      {changes.tables.length > 0 && (
        <>
          {' · '}
          {changes.tables.map((t, i) => (
            <span key={t.table}>
              {i > 0 && ', '}
              {t.table} <span className="mono">{deltaText(t.delta)}</span>
            </span>
          ))}
        </>
      )}
    </p>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="report-progress" style={{ padding: 0, alignItems: 'flex-start', flexDirection: 'row' }}>
      <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
      <p className="page-hint" style={{ margin: 0 }}>{label}</p>
    </div>
  );
}

function StatusCard({ status, loadError, failedSession, readOnly }: {
  status: DbTestingStatusOut | null;
  loadError: string;
  // the most recent `failed` session, when there's no live one to show instead
  // (see the file header — `session` never carries `failed` from the real API).
  failedSession: DbTestingSession | null;
  readOnly: boolean;
}) {
  const session = status?.session ?? null;

  return (
    <div className="init-panel sysconf-card" style={{ marginBottom: 20 }}>
      <div className="eyebrow-sm">Status</div>

      {loadError && <p className="pf-error" style={{ marginTop: 0 }}>{loadError}</p>}

      {!loadError && session?.status === 'snapshotting' && <Spinner label="Snapshotting…" />}

      {!loadError && session?.status === 'reverting' && <Spinner label="Reverting…" />}

      {!loadError && session?.status === 'active' && (
        <>
          <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>
            Testing mode ON since {longDate(session.started_at)} by{' '}
            {session.started_by_name ?? 'Unknown'}
            {session.snapshot_filename && (
              <> · snapshot <span className="mono">{session.snapshot_filename}</span></>
            )}
          </p>
          <ChangesSummary changes={status?.changes ?? null} />
        </>
      )}

      {!loadError && !session && (
        <>
          {failedSession && (
            <>
              <p className="pf-error" style={{ marginTop: 0 }}>
                Failed{failedSession.error ? `: ${failedSession.error}` : ''}
              </p>
              {readOnly && (
                <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>
                  The database was left read-only on purpose — clear it under Settings ›
                  Maintenance once you have checked it.
                </p>
              )}
            </>
          )}
          <p className="page-hint" style={{ marginTop: failedSession ? 8 : 0, marginBottom: 0 }}>
            Idle — no testing session is running.
          </p>
        </>
      )}
    </div>
  );
}

function DbTestingRevertModal({ session, changes, busy, error, onCancel, onConfirm }: {
  session: DbTestingSession;
  changes: DbTestingChanges | null;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!busy && e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const submit = () => {
    if (!password) return;
    const pw = password;
    setPassword(''); // cleared after every action, success or failure alike
    onConfirm(pw);
  };

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) onCancel(); }}
    >
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Database</div>
            <h3>Revert to the testing snapshot?</h3>
            <p className="page-hint">
              This restores the database to the snapshot taken {longDate(session.started_at)}
              {session.snapshot_filename && <> (<span className="mono">{session.snapshot_filename}</span>)</>}.
              {changes && (
                <>
                  {' '}{changes.audit_rows} audited change{changes.audit_rows === 1 ? '' : 's'} across{' '}
                  {changes.tables.length} table{changes.tables.length === 1 ? '' : 's'} will be lost.
                </>
              )}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onCancel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full">
              <label htmlFor="dbt-revert-password">Testing password</label>
              <input
                id="dbt-revert-password"
                type="password"
                autoComplete="off"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="pf-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn-solid btn-danger"
            disabled={busy || !password}
            onClick={submit}
          >
            {busy ? 'Reverting…' : 'Revert'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DbTestingTab() {
  const { godMode, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);

  const [status, setStatus] = useState<DbTestingStatusOut | null>(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState('');
  const [showRevert, setShowRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState('');

  // In-flight guard: a poll tick checks this before calling load() at all
  // (see the two poll effects below), so a slow status read is never asked
  // to overlap with another. `seqRef` additionally makes sure that if two
  // reads somehow land in flight together (e.g. a manual action's own
  // `await load()` racing a tick that started just before it), only the
  // response to the LAST request applies — an earlier one resolving late
  // can't clobber newer state.
  const loadingRef = useRef(false);
  const seqRef = useRef(0);

  const load = async () => {
    loadingRef.current = true;
    const seq = ++seqRef.current;
    try {
      const out = await getDbTestingStatus();
      if (seq === seqRef.current) {
        setStatus(out);
        setLoadError('');
      }
    } catch {
      if (seq === seqRef.current) setLoadError('Failed to load testing status.');
    } finally {
      loadingRef.current = false;
    }
  };

  useEffect(() => {
    if (!godMode) return;
    void load();
    // godMode is read once per mount of this gated view — re-running on
    // every render would just re-issue the same fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [godMode]);

  const liveSessionStatus = status?.session?.status ?? null;
  useEffect(() => {
    if (!godMode) return;
    if (!liveSessionStatus || !LIVE_STATUSES.includes(liveSessionStatus)) return;
    const timer = window.setInterval(() => {
      if (loadingRef.current) return; // never overlap a pending load
      void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [godMode, liveSessionStatus]);

  // Slow idle poll while the worker is offline and nothing is running, so
  // the chip (and Start) recover on their own once the worker comes back
  // instead of needing a remount — the 5s live-session poll above doesn't
  // run in this state at all.
  const idleWorkerOffline = godMode && status !== null
    && status.session === null && !status.worker_online;
  useEffect(() => {
    if (!idleWorkerOffline) return;
    const timer = window.setInterval(() => {
      if (loadingRef.current) return;
      void load();
    }, IDLE_WORKER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [idleWorkerOffline]);

  const { status: systemStatus } = useSystemStatus();

  if (!godMode) {
    return <p className="pf-notice">Unlock god mode to use database testing.</p>;
  }

  const session = status?.session ?? null;
  const workerOnline = status?.worker_online ?? false;
  const isActive = session?.status === 'active';
  const recent = status?.recent ?? [];
  // the API only ever puts an unfinished session in `session` — a `failed`
  // one shows up as the newest row in `recent` instead (see file header).
  const failedSession = !session && recent[0]?.status === 'failed' ? recent[0] : null;
  const recentGrid = listGridStyle(RECENT_COLUMNS, [], undefined, listGridScale);
  const recentRowStyle = {
    gridTemplateColumns: recentGrid.gridTemplateColumns, minWidth: recentGrid.minWidth,
  };

  const handleStart = async () => {
    if (!password) return;
    const pw = password;
    setPassword(''); // cleared after every action, success or failure alike
    setStarting(true);
    setActionError('');
    try {
      await startDbTesting(pw);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const handleKeep = async () => {
    if (!password) return;
    const pw = password;
    setPassword('');
    setEnding(true);
    setActionError('');
    try {
      await endDbTesting(pw, false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setEnding(false);
    }
  };

  const handleRevert = async (revertPassword: string) => {
    setReverting(true);
    setRevertError('');
    try {
      await endDbTesting(revertPassword, true);
      setShowRevert(false);
      await load();
    } catch (err) {
      setRevertError(errorMessage(err));
    } finally {
      setReverting(false);
    }
  };

  return (
    <>
      <p className="page-hint" style={{ marginBottom: 16 }}>
        Snapshot the database, make whatever changes you need, then keep them or revert straight
        back to the snapshot. The portal goes read-only for everyone while a revert runs.
      </p>

      <StatusCard
        status={status}
        loadError={loadError}
        failedSession={failedSession}
        readOnly={systemStatus.read_only}
      />

      <div className="init-panel sysconf-card" style={{ marginBottom: 20 }}>
        <div className="eyebrow-sm">Actions</div>

        <div style={{ alignItems: 'center', display: 'flex', gap: 10, marginBottom: 14 }}>
          <span className={workerOnline ? 'chip c-green' : 'chip c-red'}>
            {workerOnline ? 'Worker online' : 'Worker offline'}
          </span>
          {!workerOnline && (
            <span className="page-hint" style={{ margin: 0 }}>
              Start the db-testing worker before testing.
            </span>
          )}
        </div>

        <div className="sysconf-row">
          <div className="sysconf-field">
            <label className="sysconf-label" htmlFor="dbt-password">Testing password</label>
            <input
              id="dbt-password"
              type="password"
              autoComplete="off"
              value={password}
              disabled={starting || ending}
              onChange={(e) => { setPassword(e.target.value); setActionError(''); }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn-solid"
            disabled={session !== null || !workerOnline || !password || starting}
            onClick={() => void handleStart()}
          >
            {starting ? 'Starting…' : 'Set DB for Testing'}
          </button>
          {isActive && (
            <>
              <button
                type="button"
                className="btn-ghost"
                disabled={ending || !password}
                onClick={() => void handleKeep()}
              >
                {ending ? 'Ending…' : 'End testing · Keep changes'}
              </button>
              <button
                type="button"
                className="btn-solid btn-danger"
                disabled={ending}
                onClick={() => { setRevertError(''); setShowRevert(true); }}
              >
                End testing · Revert to snapshot
              </button>
            </>
          )}
        </div>

        {actionError && <p className="pf-error">{actionError}</p>}
      </div>

      <div className="eyebrow-sm" style={{ marginBottom: 8 }}>Recent sessions</div>
      <div className="dir-list list-scroll">
        <div className="list-head" style={recentRowStyle}>
          {RECENT_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        </div>
        {recent.length === 0 && (
          <div className="dir-empty"><b>No sessions yet.</b></div>
        )}
        {recent.map((s) => {
          const chip = outcomeChip(s);
          const by = s.started_by_name ?? 'Unknown';
          const ended = s.ended_at ? longDate(s.ended_at) : '—';
          const snapshot = s.snapshot_filename ?? '—';
          return (
            <div key={s.id} className="dir-row" style={{ minWidth: recentRowStyle.minWidth }}>
              <div className="row-main" style={recentRowStyle}>
                <div className="cell">
                  <span className="mono cell-line" title={longDate(s.started_at)}>{longDate(s.started_at)}</span>
                </div>
                <div className="cell"><span className="cell-top cell-line" title={titleFor(by)}>{by}</span></div>
                <div className="cell">
                  <span className="mono cell-line" title={titleFor(ended)}>{ended}</span>
                </div>
                <div className="cell"><span className={chip.cls}>{chip.label}</span></div>
                <div className="cell"><span className="cell-sub cell-line" title={titleFor(snapshot)}>{snapshot}</span></div>
                {/* SessionOut doesn't carry a per-session change count — only the
                    live (non-ended) session's `changes` block does — so a historical
                    row has nothing to show here. */}
                <div className="cell"><span className="mono cell-line">—</span></div>
              </div>
            </div>
          );
        })}
      </div>

      {showRevert && session && (
        <DbTestingRevertModal
          session={session}
          changes={status?.changes ?? null}
          busy={reverting}
          error={revertError}
          onCancel={() => { setShowRevert(false); setRevertError(''); }}
          onConfirm={(pw) => void handleRevert(pw)}
        />
      )}
    </>
  );
}
