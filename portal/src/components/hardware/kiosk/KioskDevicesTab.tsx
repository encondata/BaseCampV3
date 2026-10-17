/** Devices tab: this device's own details, its paired RFID reader, the
 *  printer it reports, and anything else in its reported device info.
 *  Read-only. */

import { Fragment } from 'react';

import DataTable from '../../DataTable';
import type { DeviceDetail } from '../../../lib/api';
import { subTypeLabel } from '../../../lib/devices';
import { fullDateTime } from '../../../lib/format';
import { naturalCompare } from '../../../lib/naturalSort';

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

const scalar = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : dash(v));

const keyTitle = (k: string) => {
  const words = k.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export default function KioskDevicesTab({ detail: d }: { detail: DeviceDetail }) {
  const raw = d.raw_info ?? {};
  const keys = Object.keys(raw).sort(naturalCompare);
  const printerKeys = keys.filter((k) => k.toLowerCase().includes('printer'));
  const otherKeys = keys.filter((k) => !printerKeys.includes(k));
  const reader = d.rfid_reader ?? null;
  const versions = Object.entries(reader?.versions ?? {}).sort((a, b) => naturalCompare(a[0], b[0]));

  return (
    <div className="profile-grid">
      <div className="panel">
        <div className="panel-head"><h3>This device</h3></div>
        <div className="panel-body">
          <dl className="kv">
            <dt>Platform</dt><dd>{subTypeLabel(d.sub_type)}</dd>
            <dt>Serial</dt><dd className="mono">{dash(d.serial)}</dd>
            <dt>MAC</dt><dd className="mono">{dash(d.mac)}</dd>
            <dt>LAN IP</dt><dd className="mono">{dash(d.lan_ip)}</dd>
            <dt>WAN IP</dt><dd className="mono">{dash(d.wan_ip)}</dd>
            <dt>Model</dt><dd>{dash(d.model)}</dd>
            <dt>App version</dt><dd className="mono">{dash(d.version)}</dd>
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>RFID reader</h3></div>
        <div className="panel-body">
          {reader ? (
            <dl className="kv">
              <dt>Model</dt><dd>{dash(reader.model)}</dd>
              <dt>Serial</dt><dd className="mono">{dash(reader.serial)}</dd>
              <dt>IP</dt><dd className="mono">{dash(reader.ip)}</dd>
              <dt>Paired</dt>
              <dd>{reader.paired_at ? <span className="mono">{fullDateTime(reader.paired_at)}</span> : '—'}</dd>
              {versions.map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{keyTitle(k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())}</dt>
                  <dd className="mono">{dash(v)}</dd>
                </Fragment>
              ))}
            </dl>
          ) : <p className="set-note" style={{ padding: 0 }}>No RFID reader paired.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Printer</h3></div>
        <div className="panel-body">
          {printerKeys.length ? (
            <dl className="kv">
              {printerKeys.map((k) => (
                <Fragment key={k}>
                  <dt>{keyTitle(k)}</dt><dd>{scalar(raw[k])}</dd>
                </Fragment>
              ))}
            </dl>
          ) : <p className="set-note" style={{ padding: 0 }}>No printer reported.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Reported device info</h3></div>
        <div className="panel-body">
          <DataTable ariaLabel="Reported device info"
            columns={[{ key: 'key', label: 'Field' }, { key: 'value', label: 'Value', mono: true }]}
            emptyText="This kiosk's app doesn't report device info."
            rows={otherKeys.map((k) => ({ key: k, cells: [keyTitle(k), scalar(raw[k])] }))} />
        </div>
      </div>
    </div>
  );
}
