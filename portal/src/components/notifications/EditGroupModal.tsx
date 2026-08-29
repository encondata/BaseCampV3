/**
 * EditGroupModal — name/description editor for an existing notification
 * group, invoked from NotificationGroupDetail.tsx's hero "Edit" action.
 * Model: components/access/GroupsTab.tsx's CreateGroupModal (same
 * .modal-scrim/.modal-card skeleton) — pre-filled here and diffed to a
 * partial PATCH so an untouched field never overwrites itself.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationGroup,
  type NotificationGroupDetail, type NotificationGroupPatchIn,
} from '../../lib/api';

const ERRORS: Record<string, string> = {
  group_exists: 'A group with that name already exists.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

export default function EditGroupModal({ group, onClose, onSaved }: {
  group: NotificationGroupDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const patch: NotificationGroupPatchIn = {};
    const nextName = name.trim();
    const nextDescription = description.trim();
    if (nextName !== group.name) patch.name = nextName;
    if (nextDescription !== group.description) patch.description = nextDescription;
    try {
      await updateNotificationGroup(group.id, patch);
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Edit group</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full"><label>Name *</label>
                <input value={name} required disabled={saving}
                       onChange={(e) => setName(e.target.value)} /></div>
              <div className="full"><label>Description</label>
                <input value={description} disabled={saving}
                       onChange={(e) => setDescription(e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
