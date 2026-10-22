/** Overview tab: what the kiosk is and how it last checked in. */

import type { DeviceDetail } from '../../../lib/api';
import {
  loginMethodLabel, registrationLabel, stationLabel, stationTypeLabel, subTypeLabel, tokenExpiryState,
} from '../../../lib/devices';
import { fullDateTime } from '../../../lib/format';
import { agoText, kioskOnline, syncLine } from '../../../lib/kioskConfig';

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span>Never</span>;
  return <span title={fullDateTime(iso)}>{agoText(iso)}</span>;
}

export function registrationChip(d: Pick<DeviceDetail, 'token_expires_at'>) {
  const state = tokenExpiryState(d.token_expires_at);
  const cls = state === 'ok' ? 'chip c-green' : state === 'soon' ? 'chip c-amber'
    : state === 'expired' ? 'chip c-red' : 'chip tag';
  return <span className={cls}>{registrationLabel(state)}</span>;
}

export function statusChip(d: Pick<DeviceDetail, 'last_seen_at'>) {
  return kioskOnline(d.last_seen_at)
    ? <span className="chip c-green"><span className="dot" />Online</span>
    : <span className="chip c-red"><span className="dot" />Offline</span>;
}

export default function KioskOverviewTab({ detail: d }: { detail: DeviceDetail }) {
  return (
    <div className="profile-grid">
      <div className="panel">
        <div className="panel-head"><h3>Kiosk</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Status</dt><dd>{statusChip(d)}</dd>
            <dt>Type</dt><dd>{stationTypeLabel(d)}</dd>
            <dt>Platform</dt><dd>{subTypeLabel(d.sub_type)}</dd>
            <dt>Station type</dt><dd>{stationLabel(d.station_type)}</dd>
            <dt>Version</dt><dd className="mono">{d.version ?? '—'}</dd>
            <dt>Registration</dt>
            <dd>
              {registrationChip(d)}
              {d.token_expires_at && (
                <span className="set-note" style={{ padding: 0, marginLeft: 8 }}>
                  until {fullDateTime(d.token_expires_at)}
                </span>
              )}
            </dd>
          </dl>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Check-ins</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Signed in</dt>
            <dd>
              {d.session_person_name ? (
                <span title={d.session_started_at ? `Since ${fullDateTime(d.session_started_at)}` : undefined}>
                  {d.session_person_name}
                </span>
              ) : '—'}
              {d.session_login_method && (
                <span className="chip tag" style={{ marginLeft: 8 }}>{loginMethodLabel(d.session_login_method)}</span>
              )}
            </dd>
            <dt>Last check-in</dt><dd><When iso={d.last_seen_at} /></dd>
            <dt>Last full report</dt><dd><When iso={d.config_reported_at} /></dd>
            <dt>Settings sync</dt><dd>{syncLine(d)}</dd>
            <dt>Settings version</dt><dd className="mono">{d.config_version}</dd>
            <dt>Last settings change</dt>
            <dd>
              {d.config_changed_at ? (
                <>
                  <When iso={d.config_changed_at} />
                  {d.config_source && (
                    <span className="set-note" style={{ padding: 0, marginLeft: 8 }}>
                      on the {d.config_source}{d.config_changed_by_name ? ` by ${d.config_changed_by_name}` : ''}
                    </span>
                  )}
                </>
              ) : '—'}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
