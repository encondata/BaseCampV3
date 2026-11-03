/**
 * MeNotifications — the Notifications tab of /me: what reaches the signed-in
 * person and when (saved on the account like every preference), plus the
 * notification groups they belong to.
 *
 * "What you get" is the Inbox / Email switch grid. A switch the person has not
 * changed follows the company default, which the server sends
 * (GET /notifications/settings); only their own choices are saved, so a later
 * change to a default still reaches them. The grid stays off limits until the
 * defaults have loaded. Under it the critical note names the kinds an admin
 * made critical, then the Sound row. "When email reaches you" is the schedule
 * card beside it.
 *
 * "What you watch" is the section under them: the things the person and their
 * groups watch (WatchesSection), named by the same company settings.
 *
 * The groups lists come last. Groups only list their members: they decide
 * nothing about what a person gets, so a member can ask to join or leave one
 * (a request an admin approves or rejects from the inbox popover) and that is
 * all.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import MembershipRequestModal from '../../components/notifications/MembershipRequestModal';
import ScheduleCard from '../../components/notifications/ScheduleCard';
import SwitchGrid from '../../components/notifications/SwitchGrid';
import {
  ApiError, cancelMembershipRequest, getNotificationSettings, listMyNotificationGroups,
  type MyNotificationGroup, type NotifSwitches, type NotificationCategory,
  type NotificationSettings, type NotificationSound,
} from '../../lib/api';
import { GROUP_ERRORS } from '../../lib/notificationGroups';
import type { SwitchValues } from '../../lib/notificationSwitches';
import { useSystemStatus } from '../../lib/systemStatusContext';
import { NOTIFICATION_SOUNDS, playNotificationSound } from '../../lib/notificationSounds';
import GroupsList from './GroupsList';
import SaveHint from './SaveHint';
import { usePreferenceSave } from './usePreferenceSave';
import WatchesSection from './WatchesSection';
import '../../styles/directory.css';
import '../../styles/settings.css';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (GROUP_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error.';

/** The person's own switches with one category set, or cleared when nothing
 *  of theirs is left for it (it follows the default again). */
function withCategory(
  own: NotifSwitches, category: NotificationCategory, next: SwitchValues | undefined,
): NotifSwitches {
  const switches = { ...own };
  if (next === undefined) delete switches[category];
  else switches[category] = next;
  return switches;
}

export default function MeNotifications() {
  const { preferences, update, saveState } = usePreferenceSave();

  // Until the first status lands its defaults read "email off": say nothing
  // about email until it is known.
  const { status, loaded: statusLoaded } = useSystemStatus();

  // The company defaults and the critical kinds: null while they load or if
  // they could not be loaded.
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');

  const [groups, setGroups] = useState<MyNotificationGroup[] | null>(null);
  const [loadError, setLoadError] = useState('');

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

  useEffect(() => {
    let ignore = false;   // the page went away before the answer did
    getNotificationSettings()
      .then((next) => { if (!ignore) setSettings(next); })
      .catch(() => { if (!ignore) setSettingsError('Could not load notification settings.'); });
    return () => { ignore = true; };
  }, []);

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

  // The critical kinds, in registry order (the order the server lists them).
  const criticalLabels = (settings?.kinds ?? []).filter((k) => k.critical).map((k) => k.label);

  return (
    <>
      <SaveHint state={saveState}>
        What you want to hear about — saved to your account.
      </SaveHint>

      <div className="set-stack">
        <section className="set-section me-get-card">
          <div className="set-head set-head-actions">
            <div>
              <h3>What you get</h3>
              <p>
                Emails go to your contact email; account security notices go to your sign-in
                email. Switches you haven't changed follow the company defaults.
              </p>
            </div>
            <Link className="mini-btn" to="/notifications">View all notifications</Link>
          </div>
          {statusLoaded && !status.email_enabled && (
            <p className="page-hint set-hint">
              Email isn't set up on this server yet — notifications stay in the inbox.
            </p>
          )}
          {settingsError && <p className="pf-error set-hint">{settingsError}</p>}
          <SwitchGrid
            mode="person"
            defaults={settings?.defaults ?? null}
            own={preferences.notif.switches}
            emailEnabled={statusLoaded ? status.email_enabled : null}
            onChange={(category, next) => update({
              notif: {
                ...preferences.notif,
                switches: withCategory(preferences.notif.switches, category, next),
              },
            })} />
          {settings && (
            <p className="set-note set-hint">
              Critical notifications still follow these switches, but skip your quiet hours, days
              off and the summary email. Your admins choose which are critical.
              {criticalLabels.length > 0 && <> Right now: {criticalLabels.join(', ')}.</>}
            </p>
          )}
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

        <ScheduleCard
          value={preferences.notif.schedule}
          onChange={(schedule) => update({ notif: { ...preferences.notif, schedule } })} />
      </div>

      <WatchesSection kinds={settings?.kinds ?? []} />

      <GroupsList
        kind="member"
        title="My groups"
        hint="The notification groups you belong to."
        groups={myGroups}
        loaded={groups !== null}
        busyRequestIds={cancelBusy}
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
