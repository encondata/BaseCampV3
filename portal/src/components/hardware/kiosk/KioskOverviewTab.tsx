/** Overview tab: what the kiosk is, whose personal phone it is, and how it
 *  last checked in. */

import { useState } from 'react';

import { forgetDeviceBiometric, getDevice, setDevicePersonal, type DeviceDetail } from '../../../lib/api';
import {
  SHARED_STATION_LINE, fingerprintState, fingerprintStatus, isSharedStation, personalErrorMessage,
} from '../../../lib/biometric';
import {
  loginMethodLabel, registrationLabel, stationLabel, stationTypeLabel, subTypeLabel, tokenExpiryState,
} from '../../../lib/devices';
import { fullDateTime } from '../../../lib/format';
import { agoText, kioskOnline, syncLine } from '../../../lib/kioskConfig';
import PersonalDeviceModal from './PersonalDeviceModal';

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

const STATE_CHIP = { on: 'chip c-green', expired: 'chip c-amber', off: 'chip tag' } as const;

/**
 * The Personal device row (biometric sign-in): the person whose phone this
 * is, their fingerprint status, and Choose/Change, Clear and Forget
 * fingerprint for scanning_hardware change + rank 80 (the page's `canEdit`).
 * A shared station (Label, RFID or Time Clock) can't be anyone's phone, so it
 * reads as such; a stale assignment there can still be cleared.
 */
function PersonalDevice({ detail: d, canEdit, onSaved }: {
  detail: DeviceDetail; canEdit: boolean; onSaved: (next: DeviceDetail) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shared = isSharedStation(d);
  const person = d.personal_person ?? null;
  const state = fingerprintState(d.personal_biometric);

  const clear = async () => {
    setBusy(true);
    setError('');
    try {
      onSaved(await setDevicePersonal(d.id, null));
    } catch (err) {
      setError(personalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    setError('');
    try {
      await forgetDeviceBiometric(d.id);
    } catch (err) {
      setError(personalErrorMessage(err));
      setBusy(false);
      return;
    }
    try {
      onSaved(await getDevice(d.id));
    } catch {
      // the forget went through; show it even if the reload didn't
      onSaved({ ...d, personal_biometric: { on: false, renews_at: null } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dt>Personal device</dt>
      <dd data-testid="kiosk-personal">
        <span className="kd-personal">
          {(person || !shared) && <span>{person ? person.display_name : 'None'}</span>}
          {person && !shared && (
            <span className={STATE_CHIP[state]}>{fingerprintStatus(d.personal_biometric)}</span>
          )}
          {shared && <span className="set-note" style={{ padding: 0 }}>{SHARED_STATION_LINE}</span>}
          {canEdit && !shared && (
            <button type="button" className="mini-btn" disabled={busy}
                    onClick={() => { setError(''); setPicking(true); }}>
              {person ? 'Change…' : 'Choose person…'}
            </button>
          )}
          {canEdit && person && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void clear()}>Clear</button>
          )}
          {canEdit && person && !shared && state !== 'off' && (
            <button type="button" className="mini-btn danger" disabled={busy}
                    onClick={() => void forget()}>Forget fingerprint</button>
          )}
        </span>
        {error && <p className="pf-error" role="alert" style={{ margin: '6px 0 0' }}>{error}</p>}
      </dd>
      {picking && (
        <PersonalDeviceModal detail={d} onClose={() => setPicking(false)}
                             onSaved={(next) => { setPicking(false); onSaved(next); }} />
      )}
    </>
  );
}

export default function KioskOverviewTab({ detail: d, canEdit = false, onSaved = () => {} }: {
  detail: DeviceDetail;
  /** scanning_hardware change + rank 80, as on the page's other writes. */
  canEdit?: boolean;
  onSaved?: (next: DeviceDetail) => void;
}) {
  return (
    <div className="kd-grid">
      <div className="panel">
        <div className="panel-head"><h3>Kiosk</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Status</dt><dd>{statusChip(d)}</dd>
            <dt>Type</dt><dd>{stationTypeLabel(d)}</dd>
            <dt>Platform</dt><dd>{subTypeLabel(d.sub_type)}</dd>
            <dt>Station type</dt><dd>{stationLabel(d.station_type)}</dd>
            <dt>Version</dt><dd className={d.version ? 'mono' : undefined}>{d.version ?? '—'}</dd>
            <PersonalDevice detail={d} canEdit={canEdit} onSaved={onSaved} />
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
