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
 * The revert confirmation follows the roomy modal header pattern
 * (rgm-head-text/rgm-card — see GenerateReportModal, BulkContainersModal,
 * LabelRunErrorsModal) — Jimmy's standing rule for every modal, sized to
 * its content rather than a generic fixed width.
 */

import { useEffect, useState } from 'react';

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
import '../../styles/directory.css'; /* .dir-list, .dir-row, .dir-empty */
import '../../styles/profile.css'; /* .pf-form, .pf-error, .pf-notice, .btn-solid */
import '../../styles/initiatives.css'; /* .init-panel */
import '../../styles/system.css'; /* .eyebrow-sm, .sysconf-card, .sysconf-row/-field/-label */
import '../../styles/reports.css'; /* .rgm-head-text, .rgm-card (roomy modal header) */

const POLL_MS = 5000;
const LIVE_STATUSES: DbTestingSessionStatus[] = ['snapshotting', 'active', 'reverting'];

const RECENT_GRID = { gridTemplateColumns: '1.3fr 1.1fr 1.3fr 100px 1.6fr 1fr' };

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

function StatusCard({ status, loadError }: { status: DbTestingStatusOut | null; loadError: string }) {
  const session = status?.session ?? null;

  return (
    <div className="init-panel sysconf-card" style={{ marginBottom: 20 }}>
      <div className="eyebrow-sm">Status</div>

      {loadError && <p className="pf-error" style={{ marginTop: 0 }}>{loadError}</p>}

      {!loadError && !session && (
        <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>
          Idle — no testing session is running.
        </p>
      )}

      {!loadError && session?.status === 'snapshotting' && (
        <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>Snapshotting…</p>
      )}

      {!loadError && session?.status === 'reverting' && (
        <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>Reverting…</p>
      )}

      {!loadError && session?.status === 'failed' && (
        <>
          <p className="pf-error" style={{ marginTop: 0 }}>
            Failed{session.error ? `: ${session.error}` : ''}
          </p>
          <p className="page-hint" style={{ marginTop: 0, marginBottom: 0 }}>
            The database was left read-only on purpose — clear it under Settings › Maintenance
            once you have checked it.
          </p>
        </>
      )}

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    if (!password) return;
    const pw = password;
    setPassword(''); // cleared after every action, success or failure alike
    onConfirm(pw);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card">
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
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel}>
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
  const { godMode } = useAuth();

  const [status, setStatus] = useState<DbTestingStatusOut | null>(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState('');
  const [showRevert, setShowRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState('');

  const load = async () => {
    try {
      setStatus(await getDbTestingStatus());
      setLoadError('');
    } catch {
      setLoadError('Failed to load testing status.');
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
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [godMode, liveSessionStatus]);

  if (!godMode) {
    return <p className="pf-notice">Unlock god mode to use database testing.</p>;
  }

  const session = status?.session ?? null;
  const workerOnline = status?.worker_online ?? false;
  const isActive = session?.status === 'active';

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

  const recent = status?.recent ?? [];

  return (
    <>
      <p className="page-hint" style={{ marginBottom: 16 }}>
        Snapshot the database, make whatever changes you need, then keep them or revert straight
        back to the snapshot. The portal goes read-only for everyone while a revert runs.
      </p>

      <StatusCard status={status} loadError={loadError} />

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
      <div className="dir-list">
        <div className="list-head" style={RECENT_GRID}>
          <span>Started</span>
          <span>By</span>
          <span>Ended</span>
          <span>Outcome</span>
          <span>Snapshot</span>
          <span>Changes</span>
        </div>
        {recent.length === 0 && (
          <div className="dir-empty"><b>No sessions yet.</b></div>
        )}
        {recent.map((s) => {
          const chip = outcomeChip(s);
          return (
            <div key={s.id} className="dir-row">
              <div className="row-main" style={RECENT_GRID}>
                <div className="cell">
                  <span className="mono" title={longDate(s.started_at)}>{longDate(s.started_at)}</span>
                </div>
                <div className="cell"><span className="cell-top">{s.started_by_name ?? 'Unknown'}</span></div>
                <div className="cell">
                  <span className="mono">{s.ended_at ? longDate(s.ended_at) : '—'}</span>
                </div>
                <div className="cell"><span className={chip.cls}>{chip.label}</span></div>
                <div className="cell"><span className="cell-sub">{s.snapshot_filename ?? '—'}</span></div>
                {/* SessionOut doesn't carry a per-session change count — only the
                    live (non-ended) session's `changes` block does — so a historical
                    row has nothing to show here. */}
                <div className="cell"><span className="mono">—</span></div>
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
