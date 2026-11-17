/**
 * The decision strip for an `address_blocked` inbox item, shared by the
 * toast (ToastHost) and the inbox row (InboxRow). While the block waits on
 * a decision it offers Clear block, Block permanently (timed blocks only)
 * and Leave as is; otherwise a muted outcome line read from the payload,
 * which the server rewrites for every admin once any admin decides.
 */
import { useState } from 'react';

import { ApiError, blockAddressPermanently, clearAddressBlock, type InboxItem } from '../../lib/api';
import { addressBlockOpen } from '../../lib/addressBlocked';
import { useNotifications } from '../../lib/notificationsContext';

export { addressBlockOpen };

interface AddressBlockedPayload {
  address: string;
  ends_at: string | null;
  state: string;
  decided_by?: string | null;
}

/** Another admin decided first (409) or the block row is gone (404): not an
 *  error to show — the refreshed payload says what happened. */
const SETTLED = new Set(['block_not_active', 'block_not_found']);

const errorMsg = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : 'Network error — try again.';

export default function AddressBlockedActions({ item, onDone, variant = 'row' }: {
  item: InboxItem;
  /** Runs once the decision is saved (or found already made): the toast
   *  closes itself, the row repaints from the server. */
  onDone?: () => void | Promise<void>;
  /** `toast` uses the toast's own button skin, which needs no page styles. */
  variant?: 'toast' | 'row';
}) {
  const { markRead } = useNotifications();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payload = item.payload as unknown as AddressBlockedPayload;

  if (!addressBlockOpen(item)) {
    const who = payload.decided_by;
    const label = payload.state === 'cleared' ? (who ? `Cleared by ${who}` : 'Cleared')
      : payload.state === 'permanent' ? (who ? `Blocked permanently by ${who}` : 'Blocked permanently')
      : 'Ended';
    return <span className={`notif-outcome ${variant === 'toast' ? 'toast-body' : 'notif-body'}`}>{label}</span>;
  }

  const run = async (decide?: (address: string) => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      if (decide) {
        try {
          await decide(payload.address);
        } catch (err) {
          if (!(err instanceof ApiError && SETTLED.has(err.code))) throw err;
        }
      }
      // markRead re-reads the inbox, so a decision another admin made first
      // shows up as this item's outcome line
      await markRead(item.id);
      await onDone?.();
    } catch (err) {
      setError(errorMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const btn = (danger = false) => (variant === 'toast' ? 'toast-action' : `mini-btn sm${danger ? ' danger' : ''}`);
  return (
    <span className="notif-strip" onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Enter') e.stopPropagation(); }}>
      <button type="button" className={btn()} disabled={busy} onClick={() => void run(clearAddressBlock)}>
        Clear block
      </button>
      {payload.ends_at !== null && (
        <button type="button" className={btn(true)} disabled={busy}
                onClick={() => void run(blockAddressPermanently)}>
          Block permanently
        </button>
      )}
      <button type="button" className={btn()} disabled={busy} onClick={() => void run()}>
        Leave as is
      </button>
      {error && <span className="pf-error">{error}</span>}
    </span>
  );
}
