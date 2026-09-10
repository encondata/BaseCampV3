/**
 * MembersPanel — the notification group detail page's Members card.
 * Members come straight off the loaded group (NotificationGroupDetail's
 * `load()`/`reload()` contract) — no separate fetch; only the recipients
 * list backing the add-member ComboBox is lazy-loaded on first open, and
 * filtered to exclude people already in the group. Renders a
 * `<DataTable>` ('—' per empty cell) with warning chips for channels a
 * member can't actually receive and
 * "Override" markers wherever a per-member override shadows the group
 * default. Per-row Edit opens OverrideEditorModal; Remove is a two-click
 * inline confirm, mirroring the page's own Delete button.
 */

import { useMemo, useRef, useState } from 'react';

import {
  ApiError, addNotificationMember, removeNotificationMember, listNotificationRecipients,
  type NotificationGroupDetail, type NotificationMember, type NotificationRecipient,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';
import {
  CHANNELS, CHANNEL_LABELS, canForChannel, formatDays, formatQuietHours, type Channel,
} from '../../lib/notifications';
import ComboBox, { type ComboOption } from '../ComboBox';
import DataTable from '../DataTable';
import OverrideEditorModal from './OverrideEditorModal';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? `Request failed (${err.code}).`
    : 'Network error — nothing was saved.';

/** Why a chip's channel isn't actually reachable for this person — mirrors
 *  the API's capabilities() gating (api/routes/notifications.py). */
const CHANNEL_WARNING_TITLE: Record<Channel, string> = {
  email: 'No email address on profile',
  text: 'No phone number',
  push: 'No user account',
  web: 'No user account',
};

type Capable = { can_email: boolean; can_text: boolean; can_push: boolean; can_web: boolean };

function reachableSummary(r: Capable): string {
  const reachable = CHANNELS.filter((c) => canForChannel(r, c));
  return reachable.length ? reachable.map((c) => CHANNEL_LABELS[c]).join(', ') : 'No channels available';
}

export default function MembersPanel({ group, canChange, reload }: {
  group: NotificationGroupDetail;
  canChange: boolean;
  reload: () => Promise<void>;
}) {
  const [recipients, setRecipients] = useState<NotificationRecipient[] | null>(null);
  const [recipientsError, setRecipientsError] = useState('');
  const loadStarted = useRef(false);

  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  const [editingMember, setEditingMember] = useState<NotificationMember | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const loadRecipients = () => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void listNotificationRecipients()
      .then((r) => { setRecipients(r); setRecipientsError(''); })
      .catch(() => {
        loadStarted.current = false;
        setRecipientsError('Could not load the recipient list.');
      });
  };

  const memberIds = useMemo(
    () => new Set(group.members.map((m) => m.person_id)), [group.members]);

  const options: ComboOption[] = useMemo(() => (recipients ?? [])
    .filter((r) => !memberIds.has(r.person_id))
    .map((r) => ({
      value: r.person_id,
      label: r.display_name,
      sub: [r.job_title, reachableSummary(r)].filter(Boolean).join(' · '),
    })), [recipients, memberIds]);

  const handleAdd = async (personId: string) => {
    setAddBusy(true);
    setAddError('');
    try {
      await addNotificationMember(group.id, personId);
      await reload();
    } catch (err) {
      setAddError(msgFor(err));
    } finally {
      setAddBusy(false);
    }
  };

  const handleRemove = async (personId: string) => {
    setRowBusy((b) => ({ ...b, [personId]: true }));
    setRowError((e) => ({ ...e, [personId]: '' }));
    try {
      await removeNotificationMember(group.id, personId);
      setConfirmRemove(null);
      await reload();
    } catch (err) {
      setRowError((e) => ({ ...e, [personId]: msgFor(err) }));
      setConfirmRemove(null);
    } finally {
      setRowBusy((b) => ({ ...b, [personId]: false }));
    }
  };

  return (
    <div className="init-panel" style={{ marginTop: 18 }}>
      <p className="eyebrow-sm">Members — {group.member_count}</p>

      {canChange && (
        <div className="ngd-add-member">
          <ComboBox
            options={options}
            value=""
            placeholder={recipients === null ? 'Add a member — type a name…' : 'Type a name…'}
            onOpen={loadRecipients}
            disabled={addBusy}
            onChange={(pid) => { if (pid) void handleAdd(pid); }}
          />
          {addError && <span className="pf-error">{addError}</span>}
          {recipientsError && <span className="pf-error">{recipientsError}</span>}
        </div>
      )}

      {group.members.length === 0 ? (
        <div className="dir-empty" style={{ marginTop: 12 }}>
          <b>No members yet</b>Add people above — they'll receive this group's notifications.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
        <DataTable
          ariaLabel="Members"
          className="ngd-members-table"
          columns={[
            { key: 'person', label: 'Person' },
            { key: 'contact', label: 'Contact' },
            { key: 'channels', label: 'Channels' },
            { key: 'quiet', label: 'Quiet hours' },
            { key: 'days', label: 'Days' },
            ...(canChange ? [{ key: 'actions', label: 'Actions', width: '250px' }] : []),
          ]}
          rows={group.members.map((m) => ({
            key: m.person_id,
            cells: [
              <div className="ngd-person cell-primary">
                <span className="dir-avatar ngd-avatar"
                      style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
                  {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
                </span>
                <div className="pn">
                  <b>{m.display_name}</b>
                  <span>{m.job_title ?? '—'}</span>
                </div>
              </div>,
              <div className="ngd-contact mono">
                <span>{m.email ?? '—'}</span>
                <span>{m.phone ?? '—'}</span>
              </div>,
              <div className="chips">
                {m.effective.channels.length === 0 && <span className="chip tag">Muted</span>}
                {m.effective.channels.map((c) => {
                  const channel = c as Channel;
                  const reachable = canForChannel(m, channel);
                  return (
                    <span key={c}
                          className={`chip ${reachable ? 'tag' : 'c-red'}`}
                          title={reachable ? undefined : (CHANNEL_WARNING_TITLE[channel]
                            ?? "That channel isn't available for this person.")}>
                      {CHANNEL_LABELS[channel] ?? c}
                    </span>
                  );
                })}
                {m.overrides.channels != null && <span className="chip c-amber">Override</span>}
              </div>,
              <div className="ngd-cell-marker">
                <span className="cell-top">{formatQuietHours(m.effective.quiet_start, m.effective.quiet_end, m.effective.timezone)}</span>
                {m.overrides.quiet_mode != null && <span className="chip c-amber">Override</span>}
              </div>,
              <div className="ngd-cell-marker">
                <span className="cell-top ngd-nowrap">{formatDays(m.effective.active_days)}</span>
                {m.overrides.active_days != null && <span className="chip c-amber">Override</span>}
              </div>,
              ...(canChange ? [(
                <>
                  <div className="ngd-row-actions">
                    <button className="mini-btn sm" disabled={rowBusy[m.person_id]}
                            onClick={() => setEditingMember(m)}>
                      Edit
                    </button>
                    {confirmRemove === m.person_id ? (
                      <>
                        <button className="mini-btn sm danger" disabled={rowBusy[m.person_id]}
                                onClick={() => void handleRemove(m.person_id)}>
                          {rowBusy[m.person_id] ? 'Removing…' : 'Really remove?'}
                        </button>
                        <button className="mini-btn sm" disabled={rowBusy[m.person_id]}
                                onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button className="mini-btn sm danger" disabled={rowBusy[m.person_id]}
                              onClick={() => setConfirmRemove(m.person_id)}>
                        Remove
                      </button>
                    )}
                  </div>
                  {rowError[m.person_id] && (
                    <span className="pf-error" style={{ display: 'block', marginTop: 4 }}>
                      {rowError[m.person_id]}
                    </span>
                  )}
                </>
              )] : []),
            ],
          }))}
        />
        </div>
      )}

      {editingMember && (
        <OverrideEditorModal
          group={group}
          member={editingMember}
          onClose={() => setEditingMember(null)}
          onSaved={() => { setEditingMember(null); void reload(); }}
        />
      )}
    </div>
  );
}
