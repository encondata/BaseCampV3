/**
 * MembershipRequestModal — the note prompt opened by My groups' Leave
 * action and Join a group's Join action on /me/notifications. A single
 * optional-note `.pf-form` in the shared NotificationModal; posts a
 * join/leave request that an admin approves or rejects from the inbox
 * popover (or the admin page).
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, requestGroupMembership, type MyNotificationGroup } from '../../lib/api';
import { GROUP_ERRORS } from '../../lib/notificationGroups';
import NotificationModal from './NotificationModal';

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
  const formId = useId();
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

  return (
    <NotificationModal
      eyebrow="Notification groups" title={`Ask to ${action} ${group.name}`}
      description="An admin approves the request. Add a note if it helps."
      onClose={onClose} busy={sending}
      footer={(
        <>
          <button className="btn-solid" type="submit" form={formId} disabled={sending}>
            {sending ? 'Sending…' : 'Send request'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <form id={formId} onSubmit={submit}>
        <div className="pf-form">
          <div className="full">
            <label htmlFor="mreq-note">Note (optional)</label>
            <textarea id="mreq-note" rows={3} value={note} disabled={sending}
                      placeholder="Add a reason for whoever reviews this…"
                      onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </form>
    </NotificationModal>
  );
}
