/**
 * EditGroupModal — name/description editor for an existing notification
 * group, invoked from NotificationGroupDetail.tsx's hero "Edit" action.
 * Model: components/access/GroupsTab.tsx's CreateGroupModal — pre-filled here
 * and diffed to a partial PATCH so an untouched field never overwrites
 * itself. Wears the shared NotificationModal header; the Save button sits in
 * the footer and submits the form by id, so Enter in a field still saves.
 */

import { useId, useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationGroup,
  type NotificationGroupDetail, type NotificationGroupPatchIn,
} from '../../lib/api';
import NotificationModal from './NotificationModal';

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
  const formId = useId();
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
    <NotificationModal
      eyebrow="Notification group" title="Edit group"
      description="Rename the group or change its description."
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="submit" form={formId} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <form id={formId} onSubmit={submit}>
        <div className="pf-form">
          <div className="full">
            <label htmlFor="ngd-group-name">Name *</label>
            <input id="ngd-group-name" value={name} required disabled={saving}
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="full">
            <label htmlFor="ngd-group-description">Description</label>
            <input id="ngd-group-description" value={description} disabled={saving}
                   onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
      </form>
    </NotificationModal>
  );
}
