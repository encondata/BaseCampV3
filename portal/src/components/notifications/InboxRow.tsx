/**
 * One inbox row, shared by the bell's popover and the /notifications page:
 * kind icon, unread dot, title, body, relative time, the inline strip for
 * the request/approval kinds, and the per-row Mark read / Mark unread / Hide.
 * "Hide" is a soft dismiss (dismissed_at) — rows are kept server-side.
 *
 * The row does no I/O of its own beyond the strips' decisions: opening a
 * row and the three row actions are the caller's, so the bell and the page
 * can each decide how they reach the shared inbox (and what to repaint).
 */
import { useState, type KeyboardEvent } from 'react';

import {
  ApiError, approveMembershipRequest, approveRouter, rejectMembershipRequest, revokeRouter,
  type InboxItem,
} from '../../lib/api';
import { GROUP_ERRORS } from '../../lib/notificationGroups';
/* .portal-shell's --list-* tokens live in directory.css and the shell does
   not import it — without this the row would lose Settings on any page that
   doesn't happen to load a directory list. */
import '../../styles/directory.css';
import '../../styles/toast.css';

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

/** What a strip calls once its decision is saved: the caller repaints from the
 *  server. The strip stays busy until it settles, so a slow refresh can't be
 *  met by a second click on a button that no longer applies. */
type OnChanged = () => void | Promise<void>;

/** The inline strip under a `membership_request` row: Approve/Reject while
 *  `payload.state === 'pending'` (Reject reveals a one-line note field —
 *  no modal), otherwise a muted outcome line. Stops propagation so the
 *  row click (which navigates) never fires from inside it. */
function MembershipRequestStrip({ payload, onChanged }: {
  payload: MembershipRequestPayload; onChanged: OnChanged;
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
      : 'Canceled';
    return <span className="notif-body notif-outcome">{label}</span>;
  }

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await approveMembershipRequest(payload.request_id);
      await onChanged();
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
      await onChanged();
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

export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const ROUTER_ERRORS: Record<string, string> = {
  device_not_found: 'That router was deleted.',
  not_an_agent_router: 'That router no longer reports through the agent.',
  forbidden: "You can't approve routers.",
};

const routerErrorMsg = (err: unknown): string =>
  err instanceof ApiError ? (ROUTER_ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

interface RouterApprovalPayload {
  device_id: string;
  state: string;
  decided_by?: string | null;
}

/** The inline strip under a `router_approval` row: Approve / Reject while
 *  pending (Reject revokes — a router has no note to keep), otherwise the
 *  outcome. Stops propagation so the row click (which opens the Routers
 *  page focused on this router) never fires from inside it. */
function RouterApprovalStrip({ payload, onChanged }: {
  payload: RouterApprovalPayload; onChanged: OnChanged;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (payload.state !== 'pending') {
    const verb = payload.state === 'approved' ? 'Approved'
      : payload.state === 'revoked' ? 'Rejected' : 'Decided';
    const label = payload.decided_by ? `${verb} by ${payload.decided_by}` : verb;
    return <span className="notif-body notif-outcome">{label}</span>;
  }

  const decide = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn(payload.device_id);
      await onChanged();
    } catch (err) {
      setError(routerErrorMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="notif-strip" onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
      <button type="button" className="mini-btn sm" disabled={busy}
              onClick={() => void decide(approveRouter)}>
        Approve
      </button>
      <button type="button" className="mini-btn sm danger" disabled={busy}
              onClick={() => void decide(revokeRouter)}>
        Reject
      </button>
      {error && <span className="pf-error">{error}</span>}
    </span>
  );
}

interface ResetRequestPayload {
  state: string;
  count?: number;
  resolved_by?: string | null;
}

/** The outcome line under a `password_reset_request` row: who resolved it,
 *  or how many times the person has asked while it's open. */
function ResetRequestOutcome({ payload }: { payload: ResetRequestPayload }) {
  if (payload.state === 'resolved') {
    return (
      <span className="notif-body notif-outcome">
        {payload.resolved_by ? `Resolved by ${payload.resolved_by}` : 'Resolved'}
      </span>
    );
  }
  if ((payload.count ?? 1) > 1) {
    return <span className="notif-body notif-outcome">Asked {payload.count} times</span>;
  }
  return null;
}

export function KindIcon({ kind }: { kind: string }) {
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
  if (kind === 'router_approval') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 16.5h.01M11 16.5h.01" />
        <path d="M15 13V9M9 7.5a4.2 4.2 0 0 1 6 0M6.5 5a7.8 7.8 0 0 1 11 0" />
      </svg>
    );
  }
  if (kind === 'password_reset_request') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
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
  if (kind === 'totp_enrolled') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 19 6v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6Z" /><path d="m8.8 12 2.3 2.3L15.5 9.8" />
      </svg>
    );
  }
  if (kind === 'password_expiring') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16 6.5l2.5 2.5M13.5 9l2.5 2.5" />
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

/** Keyboard for a row: ArrowDown/ArrowUp move focus to the next/previous row
 *  inside `list` (all the rows in it, whichever group they sit in); Enter
 *  opens the row. Pass it as the row's `onKeyDown`. */
export function onRowKeys(
  e: KeyboardEvent<HTMLDivElement>, list: HTMLElement | null, open: () => void,
): void {
  const rows = Array.from(list?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? []);
  const idx = rows.indexOf(e.currentTarget);
  if (e.key === 'ArrowDown') { e.preventDefault(); rows[idx + 1]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); rows[idx - 1]?.focus(); }
  else if (e.key === 'Enter') { e.preventDefault(); open(); }
}

export default function InboxRow({ item: n, onOpen, onMarkRead, onMarkUnread, onHide, onChanged, onKeyDown }: {
  item: InboxItem;
  /** The row was clicked (or Enter on it): mark it read and follow its link. */
  onOpen: (item: InboxItem) => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onHide: (id: string) => void;
  /** An Approve/Reject strip saved its decision: repaint from the server. */
  onChanged: OnChanged;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div role="listitem" tabIndex={0}
         className={`notif-row ${n.read_at ? '' : 'unread'}`}
         onClick={() => onOpen(n)} onKeyDown={onKeyDown}>
      <KindIcon kind={n.kind} />
      <span className="notif-text">
        <span className="notif-title">
          {!n.read_at && <span className="notif-dot" aria-hidden="true" />}
          {n.title}
        </span>
        {n.body && <span className="notif-body">{n.body}</span>}
        <span className="notif-time">{relativeTime(n.created_at)}</span>
        {n.kind === 'membership_request' && (
          <MembershipRequestStrip payload={n.payload as unknown as MembershipRequestPayload} onChanged={onChanged} />
        )}
        {n.kind === 'router_approval' && (
          <RouterApprovalStrip payload={n.payload as unknown as RouterApprovalPayload} onChanged={onChanged} />
        )}
        {n.kind === 'password_reset_request' && (
          <ResetRequestOutcome payload={n.payload as unknown as ResetRequestPayload} />
        )}
      </span>
      <span className="notif-actions" onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
        {n.read_at ? (
          <button type="button" className="icon-btn" aria-label="Mark unread" data-tip="Mark unread"
                  onClick={() => onMarkUnread(n.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /></svg>
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label="Mark read" data-tip="Mark read"
                  onClick={() => onMarkRead(n.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Hide" data-tip="Hide"
                onClick={() => onHide(n.id)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
        </button>
      </span>
    </div>
  );
}
