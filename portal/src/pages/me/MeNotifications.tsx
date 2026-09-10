/**
 * MeNotifications — the Notifications tab of /me: what the signed-in
 * person wants to hear about (saved on the account like every
 * preference), plus (Task 3) the notification groups they belong to —
 * tune per-group overrides or ask to leave — and a search-and-join list
 * for the rest. Joining/leaving is a request an admin approves or
 * rejects from the inbox popover; overrides apply immediately via the
 * self-service PATCH, reusing OverrideEditorModal (built for the admin
 * group-detail page) through the lib/notificationGroups.ts adapters.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import MembershipRequestModal from '../../components/notifications/MembershipRequestModal';
import OverrideEditorModal from '../../components/notifications/OverrideEditorModal';
import { Switch } from '../../components/Switch';
import {
  ApiError, cancelMembershipRequest, listMyNotificationGroups, updateMyGroupOverrides,
  type MyNotificationGroup, type NotificationSound, type UiPreferences,
} from '../../lib/api';
import {
  GROUP_ERRORS, toGroupDetail, toMember,
} from '../../lib/notificationGroups';
import { NOTIFICATION_SOUNDS, playNotificationSound } from '../../lib/notificationSounds';
import GroupsList from './GroupsList';
import SaveHint from './SaveHint';
import { usePreferenceSave } from './usePreferenceSave';
import '../../styles/directory.css';
import '../../styles/settings.css';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (GROUP_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error.';

export default function MeNotifications() {
  const { preferences, update, saveState } = usePreferenceSave();
  const { person } = useAuth();

  const notifRow = (key: Exclude<keyof UiPreferences['notif'], 'sound'>, label: string, sub: string) => (
    <div className="set-row">
      <div className="set-label"><b>{label}</b><span>{sub}</span></div>
      <Switch checked={preferences.notif[key]}
              onChange={(v) => update({ notif: { ...preferences.notif, [key]: v } })} />
    </div>
  );

  const [groups, setGroups] = useState<MyNotificationGroup[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [editingGroup, setEditingGroup] = useState<MyNotificationGroup | null>(null);
  const [requestFor, setRequestFor] =
    useState<{ group: MyNotificationGroup; action: 'join' | 'leave' } | null>(null);
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [cancelError, setCancelError] = useState<Record<string, string>>({});

  const load = () => {
    void listMyNotificationGroups()
      .then((rows) => { setGroups(rows); setLoadError(''); })
      .catch(() => setLoadError('Could not load notification groups.'));
  };

  useEffect(() => { load(); }, []);

  const myGroups = useMemo(() => (groups ?? []).filter((g) => g.is_member), [groups]);
  const joinable = useMemo(() => (groups ?? []).filter((g) => !g.is_member), [groups]);
  const handleCancel = async (requestId: string) => {
    setCancelBusy((b) => ({ ...b, [requestId]: true }));
    setCancelError((e) => ({ ...e, [requestId]: '' }));
    try {
      await cancelMembershipRequest(requestId);
      load();
    } catch (err) {
      setCancelError((e) => ({ ...e, [requestId]: msgFor(err) }));
    } finally {
      setCancelBusy((b) => ({ ...b, [requestId]: false }));
    }
  };

  return (
    <>
      <SaveHint state={saveState}>
        What you want to hear about — saved to your account.
      </SaveHint>

      <div className="set-stack">
        <section className="set-section">
          <div className="set-head">
            <h3>Notifications</h3>
            <p>Delivery wiring lands with the notification service.</p>
          </div>
          {notifRow('critical', 'Critical incidents', 'Immediate alerts for anything move-blocking.')}
          {notifRow('email', 'Email alerts', 'Send notifications to your contact email.')}
          {notifRow('maint', 'Maintenance windows', 'Scheduled downtime and system maintenance notices.')}
          {notifRow('digest', 'Weekly digest', 'A summary of activity across your projects.')}
          <div className="set-row">
            <div className="set-label">
              <b>Sound</b>
              <span>Played in the portal when a new notification arrives. Preview to hear it.</span>
            </div>
            <div className="set-inline">
              <div className="seg-mini" role="radiogroup" aria-label="Notification sound">
                {NOTIFICATION_SOUNDS.map((o) => (
                  <button key={o.key} type="button" role="radio"
                          aria-checked={preferences.notif.sound === o.key}
                          className={preferences.notif.sound === o.key ? 'on' : ''}
                          onClick={() => update({ notif: { ...preferences.notif, sound: o.key as NotificationSound } })}>
                    {o.label}
                  </button>
                ))}
              </div>
              <button type="button" className="mini-btn" disabled={preferences.notif.sound === 'none'}
                      onClick={() => playNotificationSound(preferences.notif.sound)}>
                Preview
              </button>
            </div>
          </div>
        </section>
      </div>

      <GroupsList
        kind="member"
        title="My groups"
        hint="Notification groups you belong to — tune your own overrides or ask to leave."
        groups={myGroups}
        loaded={groups !== null}
        busyRequestIds={cancelBusy}
        onEditOverrides={(g) => setEditingGroup(g)}
        onRequest={(group, action) => setRequestFor({ group, action })}
        onCancel={(id) => void handleCancel(id)}
      />
      {loadError && <p className="pf-error">{loadError}</p>}
      {Object.values(cancelError).filter(Boolean).map((msg, i) => (
        <p key={i} className="pf-error">{msg}</p>
      ))}

      <GroupsList
        kind="joinable"
        title="Join a group"
        hint="Search other notification groups and ask to join."
        groups={joinable}
        loaded={groups !== null}
        busyRequestIds={cancelBusy}
        onRequest={(group, action) => setRequestFor({ group, action })}
        onCancel={(id) => void handleCancel(id)}
      />

      {editingGroup && person && (
        <OverrideEditorModal
          group={toGroupDetail(editingGroup)}
          member={toMember(editingGroup, person)}
          onSave={(body) => updateMyGroupOverrides(editingGroup.id, body)}
          onClose={() => setEditingGroup(null)}
          onSaved={() => { setEditingGroup(null); load(); }}
        />
      )}

      {requestFor && (
        <MembershipRequestModal
          group={requestFor.group}
          action={requestFor.action}
          onClose={() => setRequestFor(null)}
          onSent={() => { setRequestFor(null); load(); }}
        />
      )}
    </>
  );
}
