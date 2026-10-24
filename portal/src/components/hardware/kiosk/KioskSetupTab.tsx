/** Setup & move tab: the Kiosk Setup choices. Move, site and station type
 *  stay on the kiosk (read-only here); a super admin can change the scan
 *  type, limited to the options the API offers for this move and station.
 *  A Time Clock station scans no assets, so it gets no scan type picker. */

import { useEffect, useState, type CSSProperties } from 'react';

import ComboBox from '../../ComboBox';
import { ApiError, setDeviceScanType, type DeviceDetail } from '../../../lib/api';
import { stationLabel } from '../../../lib/devices';

const ROLE_LABELS: Record<string, string> = { source: 'Source', destination: 'Destination' };

const SCAN_ERRORS: Record<string, string> = {
  no_move: 'This kiosk has no move, so it has no scan type to change.',
  bad_scan_status: "That scan type isn't allowed for this move and station.",
  forbidden_rank: 'Only super admins can change the scan type.',
  forbidden: 'Only super admins can change the scan type.',
};

export default function KioskSetupTab({ detail: d, canEdit, onSaved }: {
  detail: DeviceDetail; canEdit: boolean; onSaved: (next: DeviceDetail) => void;
}) {
  const setup = d.setup;
  const [pick, setPick] = useState(setup.scan_status ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setPick(setup.scan_status ?? ''); }, [setup.scan_status]);

  const save = async () => {
    if (!pick) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      onSaved(await setDeviceScanType(d.id, pick));
      setNote('Saved. The kiosk switches at its next check-in.');
    } catch (err) {
      setError(err instanceof ApiError
        ? (SCAN_ERRORS[err.code] ?? (err.code === 'read_only_mode' ? err.message : `Couldn't save (${err.code}).`))
        : "Couldn't reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  const current = d.scan_type_options.find((o) => o.key === setup.scan_status);
  const options = d.scan_type_options.map((o) => ({ value: o.key, label: o.label }));

  return (
    <div className="kd-grid">
      <div className="panel">
        <div className="panel-head"><h3>Kiosk Setup</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Move</dt><dd>{setup.initiative_name ?? '—'}</dd>
            <dt>Site</dt>
            <dd>
              {setup.site_name ?? '—'}
              {setup.site_role && (
                <span className="chip tag" style={{ marginLeft: 8 }}>{ROLE_LABELS[setup.site_role] ?? setup.site_role}</span>
              )}
            </dd>
            <dt>Station type</dt>
            <dd>{stationLabel(setup.station_type)}</dd>
          </dl>
          <p className="set-note" style={{ padding: 0, marginTop: 12 }}>
            The move, site and station type are chosen in Kiosk Setup on the kiosk itself.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Scan type</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Current</dt>
            <dd>
              {setup.scan_status ? (
                <span className="chip custom" style={{ '--chip': current?.color ?? d.scan_status_color } as CSSProperties}>
                  <span className="dot" />{setup.scan_status_label ?? setup.scan_status}
                </span>
              ) : '—'}
            </dd>
          </dl>
          {canEdit && setup.station_type !== 'timeclock' && (
            setup.initiative_id && options.length > 0 ? (
              <div style={{ marginTop: 14 }}>
                <div className="kd-scan-pick">
                  <ComboBox ariaLabel="Scan type" options={options} value={pick}
                            onChange={(v) => { setPick(v); setNote(''); setError(''); }} />
                  <button type="button" className="btn-solid" aria-label="Save scan type"
                          disabled={busy || !pick || pick === setup.scan_status} onClick={() => void save()}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {d.sub_type === 'laptop' && setup.station_type === 'rfid' && (
                  <p className="set-note" style={{ padding: 0, marginTop: 8 }}>
                    An RFID Station offers only scan types whose name includes RFID.
                  </p>
                )}
              </div>
            ) : (
              <p className="set-note" style={{ padding: 0, marginTop: 12 }}>
                The scan type can be changed once the kiosk is set up on a move.
              </p>
            )
          )}
          {error && <p className="pf-error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
          {note && <p className="set-note" role="status" style={{ padding: 0, marginTop: 8 }}>{note}</p>}
        </div>
      </div>
    </div>
  );
}
