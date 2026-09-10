/**
 * MeNotifications — the Notifications tab of /me: what the signed-in
 * person wants to hear about. Saved on the account like every preference.
 */

import { Switch } from '../../components/Switch';
import type { UiPreferences } from '../../lib/api';
import SaveHint from './SaveHint';
import { usePreferenceSave } from './usePreferenceSave';
import '../../styles/settings.css';

export default function MeNotifications() {
  const { preferences, update, saveState } = usePreferenceSave();

  const notifRow = (key: keyof UiPreferences['notif'], label: string, sub: string) => (
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
        </section>
      </div>
    </>
  );
}
