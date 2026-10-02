/** Settings › Edge (laptop edition only): is the cloud reachable, what move
 *  data does this laptop hold, and what is still waiting to upload. Sync
 *  now / Retry failed for anyone signed in; Wipe this laptop for admins,
 *  with a typed WIPE gate when queued work would be lost. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { ApiError, edgeRetryFailed, edgeSyncNow, edgeWipe } from '../lib/api';
import { useEdgeStatus } from '../lib/edgeStatus';
import { clearDb } from '../lib/localDb';
import { resetSyncStatus } from '../lib/sync';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

export default function EdgePanel() {
  const { isAdmin, logout } = useKioskAuth();
  const navigate = useNavigate();
  const { status, refresh } = useEdgeStatus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [wipePending, setWipePending] = useState<number | null>(null);
  const [typed, setTyped] = useState('');

  if (!status) return <p className="page-hint">Checking this laptop&apos;s edge service…</p>;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote('');
    try {
      await action();
      setNote(done);
    } catch {
      setNote('That did not work. Check the cloud connection and try again.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const wipe = async (confirm?: string) => {
    setBusy(true);
    try {
      const result = await edgeWipe(confirm);
      if (result.cleared_move_data) await clearDb().then(resetSyncStatus).catch(() => {});
      await logout();
      navigate('/login');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'outbox_not_empty') {
        setWipePending((e.detail as { pending?: number } | undefined)?.pending ?? 0);
      } else {
        setNote('Wipe failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const o = status.outbox;
  return (
    <>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Version</span>
          <p className="page-hint">{status.version}</p>
        </div>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Cloud</span>
          <p className="page-hint">Last contact {when(status.cloud.last_contact)}</p>
        </div>
        <span className={`chip ${status.cloud.online ? 'c-green' : 'c-red'}`}>
          <span className="dot" />{status.cloud.online ? 'Online' : 'Offline'}
        </span>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Move data</span>
          <p className="page-hint">
            {status.sync.initiative_id
              ? `Synced ${when(status.sync.synced_at)}${status.sync.last_error ? ` · last attempt failed (${status.sync.last_error})` : ''}`
              : 'No move set up yet. Run Kiosk Setup while online.'}
          </p>
        </div>
        <button type="button" className="mini-btn" disabled={busy}
                onClick={() => void run(edgeSyncNow, 'Move data refreshed.')}>
          Sync now
        </button>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Upload queue</span>
          <p className="page-hint">
            {o.queued + o.sending} waiting · {o.sent} sent · {o.failed} failed · {o.rejected} rejected
          </p>
          {status.waiting.map((w, i) => (
            <p key={`${w.person_name}-${i}`} className="page-hint">
              {w.count} scans waiting for {w.person_name} to sign in online
            </p>
          ))}
        </div>
        <button type="button" className="mini-btn" disabled={busy}
                onClick={() => void run(edgeRetryFailed, 'Failed uploads queued again.')}>
          Retry failed
        </button>
      </div>
      {note && <p className="form-notice" role="status">{note}</p>}
      {isAdmin && (
        <div className="settings-row">
          <div>
            <span className="settings-row-label">Wipe this laptop</span>
            <p className="page-hint">
              Signs everyone out and removes saved sign-ins, the move password, and move data.
              This laptop&apos;s name and serial stay.
            </p>
            {wipePending !== null && (
              <div className="pf-form">
                <p className="form-error" role="alert">
                  {wipePending} queued items have not reached the portal and will be lost.
                </p>
                <label htmlFor="edge-wipe-confirm">Type WIPE to confirm</label>
                <input id="edge-wipe-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
                <button type="button" className="btn-solid" disabled={busy || typed !== 'WIPE'}
                        onClick={() => void wipe('WIPE')}>
                  Wipe anyway
                </button>
              </div>
            )}
          </div>
          {wipePending === null && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void wipe()}>
              Wipe this laptop
            </button>
          )}
        </div>
      )}
    </>
  );
}
