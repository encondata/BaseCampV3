/**
 * MembershipRequestModal — the note prompt opened by My groups' Leave
 * action and Join a group's Join action on /me/notifications. A single
 * optional-note `.pf-form`, mirroring EditGroupModal's small-modal
 * skeleton; posts a join/leave request that an admin approves or rejects
 * from the inbox popover (or the admin page).
 */

import { useState, type FormEvent } from 'react';

import { ApiError, requestGroupMembership, type MyNotificationGroup } from '../../lib/api';
import { GROUP_ERRORS } from '../../lib/notificationGroups';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (GROUP_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was sent.';

export default function MembershipRequestModal({ group, action, onClose, onSent }: {
  group: MyNotificationGroup;
  action: 'join' | 'leave';
  onClose: () => void;
  onSent: () => void;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      await requestGroupMembership(group.id, action, note.trim());
      onSent();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSending(false);
    }
  };

  const dismiss = () => { if (!sending) onClose(); };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) dismiss();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Ask to {action} {group.name}</h3>
          <button className="modal-close" aria-label="Close" onClick={dismiss}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="mreq-note">Note (optional)</label>
                <textarea id="mreq-note" rows={3} value={note} disabled={sending}
                          placeholder="Add a reason for whoever reviews this…"
                          onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            {error && <span className="pf-error">{error}</span>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={sending}>
              {sending ? 'Sending…' : 'Send request'}
            </button>
            <button className="mini-btn" type="button" onClick={dismiss} disabled={sending}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
