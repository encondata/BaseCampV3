/**
 * MeNotifications — the Notifications tab of /me: what the signed-in
 * person wants to hear about. Saved on the account like every preference.
 */

import { Switch } from '../../components/Switch';
import type { NotificationSound, UiPreferences } from '../../lib/api';
import { NOTIFICATION_SOUNDS, playNotificationSound } from '../../lib/notificationSounds';
import SaveHint from './SaveHint';
import { usePreferenceSave } from './usePreferenceSave';
import '../../styles/settings.css';

export default function MeNotifications() {
  const { preferences, update, saveState } = usePreferenceSave();

  const notifRow = (key: Exclude<keyof UiPreferences['notif'], 'sound'>, label: string, sub: string) => (
    <div className="set-row">
      <div className="set-label"><b>{label}</b><span>{sub}</span></div>
      <Switch checked={preferences.notif[key]}
              onChange={(v) => update({ notif: { ...preferences.notif, [key]: v } })} />
    </div>
  );

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
    </>
  );
}
