/**
 * The bell's popover: Settings-aware (list text size + density via the
 * directory list tokens), kind icons, unread marker, per-row Mark read /
 * Mark unread / Hide, header Mark all read / Clear read, keyboard nav.
 * "Hide" is a soft dismiss (dismissed_at) — rows are kept server-side.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  ApiError, approveMembershipRequest, rejectMembershipRequest, type InboxItem,
} from '../lib/api';
import { GROUP_ERRORS } from '../lib/notificationGroups';
import { useNotifications } from '../lib/notificationsContext';
/* .portal-shell's --list-* tokens live in directory.css and the shell does
   not import it — without this the panel would lose Settings on any page
   that doesn't happen to load a directory list. */
import '../styles/directory.css';
import '../styles/toast.css';

/** Copy for request-decision error codes, reusing the self-service
 *  mapping plus the one code that only shows up here (a second click on
 *  an already-decided request). */
const REQUEST_ERRORS: Record<string, string> = {
  ...GROUP_ERRORS,
  already_decided: 'That request was already decided.',
};

const requestErrorMsg = (err: unknown): string =>
  err instanceof ApiError ? (REQUEST_ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

interface MembershipRequestPayload {
  request_id: string;
  state: string;
  decided_by?: string | null;
}

/** The inline strip under a `membership_request` row: Approve/Reject while
 *  `payload.state === 'pending'` (Reject reveals a one-line note field —
 *  no modal), otherwise a muted outcome line. Stops propagation so the
 *  row click (which navigates) never fires from inside it. */
function MembershipRequestStrip({ payload, refresh }: {
  payload: MembershipRequestPayload; refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (payload.state !== 'pending') {
    const who = payload.decided_by ?? '';
    const label = payload.state === 'approved' ? `Approved by ${who}`
      : payload.state === 'rejected' ? `Rejected by ${who}`
      : 'Cancelled';
    return <span className="notif-body notif-outcome">{label}</span>;
  }

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await approveMembershipRequest(payload.request_id);
      await refresh();
    } catch (err) {
      setError(requestErrorMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmReject = async () => {
    setBusy(true);
    setError('');
    try {
      await rejectMembershipRequest(payload.request_id, note.trim());
      await refresh();
    } catch (err) {
      setError(requestErrorMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="notif-strip" onClick={stop}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
      {rejecting ? (
        <span className="pf-form" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input placeholder="Reason (optional)" value={note} disabled={busy}
                 onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="mini-btn sm" disabled={busy} onClick={() => void confirmReject()}>
            Confirm reject
          </button>
          <button type="button" className="mini-btn sm" disabled={busy}
                  onClick={() => { setRejecting(false); setNote(''); setError(''); }}>
            Cancel
          </button>
        </span>
      ) : (
        <>
          <button type="button" className="mini-btn sm" disabled={busy} onClick={() => void approve()}>
            Approve
          </button>
          <button type="button" className="mini-btn sm danger" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </button>
        </>
      )}
      {error && <span className="pf-error">{error}</span>}
    </span>
  );
}

export const INBOX_CAP = 50;

export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = `notif-icon notif-icon-${kind}`;
  if (kind === 'report_ready') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (kind === 'report_failed') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17h.01" />
      </svg>
    );
  }
  if (kind === 'membership_request') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3.4 2.6-5.6 5.5-5.6s5.5 2.2 5.5 5.6" />
        <path d="M18.5 8v6M15.5 11h6" />
      </svg>
    );
  }
  if (kind === 'membership_decided') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.6 2.6L16.5 9" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markUnread, markAllRead, hide, clearRead, refresh } = useNotifications();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const readCount = items.filter((i) => i.read_at).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (n: InboxItem) => {
    if (!n.read_at) void markRead(n.id);
    onClose();
    if (n.link) navigate(n.link);
  };

  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: InboxItem, idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]');
    if (e.key === 'ArrowDown') { e.preventDefault(); rows?.[idx + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows?.[idx - 1]?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(n); }
  };

  return (
    <div className="pop-menu notif-panel" role="dialog" aria-label="Notifications">
      <div className="notif-head">
        <span className="pop-title">Notifications</span>
        {unreadCount > 0 && <span className="notif-chip">{unreadCount} unread</span>}
        <span className="notif-head-actions">
          <button type="button" className="btn-ghost" disabled={unreadCount === 0}
                  onClick={() => void markAllRead()}>Mark all read</button>
          <button type="button" className="btn-ghost" disabled={readCount === 0}
                  onClick={() => void clearRead()}>Clear read</button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="pop-empty notif-empty">
          <KindIcon kind="bell" />
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="notif-list" role="list" ref={listRef}>
          {items.map((n, idx) => (
            <div key={n.id} role="listitem" tabIndex={0}
                 className={`notif-row ${n.read_at ? '' : 'unread'}`}
                 onClick={() => open(n)} onKeyDown={(e) => onRowKey(e, n, idx)}>
              <KindIcon kind={n.kind} />
              <span className="notif-text">
                <span className="notif-title">
                  {!n.read_at && <span className="notif-dot" aria-hidden="true" />}
                  {n.title}
                </span>
                {n.body && <span className="notif-body">{n.body}</span>}
                <span className="notif-time">{relativeTime(n.created_at)}</span>
                {n.kind === 'membership_request' && (
                  <MembershipRequestStrip payload={n.payload as unknown as MembershipRequestPayload} refresh={refresh} />
                )}
              </span>
              <span className="notif-actions" onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
                {n.read_at ? (
                  <button type="button" className="icon-btn" aria-label="Mark unread" data-tip="Mark unread"
                          onClick={() => void markUnread(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /></svg>
                  </button>
                ) : (
                  <button type="button" className="icon-btn" aria-label="Mark read" data-tip="Mark read"
                          onClick={() => void markRead(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label="Hide" data-tip="Hide"
                        onClick={() => void hide(n.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {items.length >= INBOX_CAP && <div className="notif-foot">Showing the {INBOX_CAP} most recent</div>}
    </div>
  );
}
