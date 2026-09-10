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
  GROUP_ERRORS, daysText, hasOverrides, quietHoursText, toGroupDetail, toMember,
} from '../../lib/notificationGroups';
import { CHANNEL_LABELS, type Channel } from '../../lib/notifications';
import { NOTIFICATION_SOUNDS, playNotificationSound } from '../../lib/notificationSounds';
import SaveHint from './SaveHint';
import { usePreferenceSave } from './usePreferenceSave';
import '../../styles/directory.css';
import '../../styles/settings.css';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (GROUP_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error.';

const CHANNEL_CHIP: Record<string, string> = {
  email: 'c-blue', web: 'c-green', sms: 'c-amber', text: 'c-amber', push: 'c-violet',
};

function ChannelChips({ channels }: { channels: string[] }) {
  return (
    <div className="chips">
      {channels.length === 0 && <span className="chip c-slate">None</span>}
      {channels.map((c) => (
        <span key={c} className={`chip ${CHANNEL_CHIP[c] ?? 'c-slate'}`}>
          {CHANNEL_LABELS[c as Channel] ?? c}
        </span>
      ))}
    </div>
  );
}

function GroupNameCell({ group }: { group: MyNotificationGroup }) {
  return (
    <div>
      <div className="cell-primary">
        <div className="pn"><b>{group.name}</b></div>
      </div>
      {group.description && <div className="cell-sub">{group.description}</div>}
    </div>
  );
}

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
  const [query, setQuery] = useState('');

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
  const filteredJoinable = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return joinable;
    return joinable.filter((g) =>
      g.name.toLowerCase().includes(needle) || g.description.toLowerCase().includes(needle));
  }, [joinable, query]);

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

      <section className="set-section" style={{ marginTop: 18 }}>
        <div className="set-head">
          <h3>My groups</h3>
          <p>Notification groups you belong to — tune your own overrides or ask to leave.</p>
        </div>
        {loadError && <p className="pf-error mynotif-note">{loadError}</p>}
        {groups !== null && myGroups.length === 0 && !loadError && (
          <div className="dir-empty">You&apos;re not in any notification groups yet.</div>
        )}
        {myGroups.length > 0 && (
          <div className="mini-list mynotif-body">
            <div className="mini-list-head mynotif-my-head">
              <span>Group</span>
              <span>Channels</span>
              <span>Quiet hours</span>
              <span>Days</span>
              <span>Actions</span>
            </div>
            {myGroups.map((g) => {
              const pending = g.pending_request;
              return (
                <div key={g.id} className="mini-row mynotif-my-row">
                  <GroupNameCell group={g} />
                  <ChannelChips channels={g.channels} />
                  <span className="mono">{quietHoursText(g)}</span>
                  <span className="cell-top">{daysText(g.active_days)}</span>
                  <div className="mynotif-actions">
                    {hasOverrides(g.overrides) && <span className="chip c-aqua">Customised</span>}
                    <button className="mini-btn sm" onClick={() => setEditingGroup(g)}>
                      Edit overrides
                    </button>
                    {pending && pending.action === 'leave' ? (
                      <>
                        <span className="chip c-amber"><span className="dot" />Leave requested</span>
                        <button className="mini-btn sm" disabled={cancelBusy[pending.id]}
                                onClick={() => void handleCancel(pending.id)}>
                          {cancelBusy[pending.id] ? 'Cancelling…' : 'Cancel'}
                        </button>
                      </>
                    ) : (
                      <button className="mini-btn sm" disabled={!!pending}
                              onClick={() => setRequestFor({ group: g, action: 'leave' })}>
                        Leave
                      </button>
                    )}
                    {pending && cancelError[pending.id] && (
                      <span className="pf-error">{cancelError[pending.id]}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="set-section" style={{ marginTop: 18 }}>
        <div className="set-head">
          <h3>Join a group</h3>
          <p>Search other notification groups and ask to join.</p>
        </div>
        <div className="dir-search mynotif-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search groups…" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        {groups !== null && filteredJoinable.length === 0 && (
          <div className="dir-empty">No other groups to join.</div>
        )}
        {filteredJoinable.length > 0 && (
          <div className="mini-list mynotif-body">
            <div className="mini-list-head mynotif-join-head">
              <span>Group</span>
              <span>Channels</span>
              <span>Members</span>
              <span>Actions</span>
            </div>
            {filteredJoinable.map((g) => {
              const pending = g.pending_request;
              return (
                <div key={g.id} className="mini-row mynotif-join-row">
                  <GroupNameCell group={g} />
                  <ChannelChips channels={g.channels} />
                  <span className="mono">{g.member_count} member{g.member_count === 1 ? '' : 's'}</span>
                  <div className="mynotif-actions">
                    {pending && pending.action === 'join' ? (
                      <>
                        <span className="chip c-amber"><span className="dot" />Join requested</span>
                        <button className="mini-btn sm" disabled={cancelBusy[pending.id]}
                                onClick={() => void handleCancel(pending.id)}>
                          {cancelBusy[pending.id] ? 'Cancelling…' : 'Cancel'}
                        </button>
                      </>
                    ) : (
                      <button className="mini-btn sm" disabled={!!pending}
                              onClick={() => setRequestFor({ group: g, action: 'join' })}>
                        Join
                      </button>
                    )}
                    {pending && cancelError[pending.id] && (
                      <span className="pf-error">{cancelError[pending.id]}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

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
