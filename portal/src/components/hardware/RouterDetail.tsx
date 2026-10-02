/** Expansion panel for a router row. Approved routers: DHCP clients /
 *  WiFi / VPN behind an explicit switcher, each a real table (house
 *  detail-surface rules). A pending or revoked router's reports are held,
 *  so it shows only what identifies it — enough to decide on approval. */

import { useState } from 'react';

import DataTable from '../DataTable';
import type { DeviceItem } from '../../lib/api';
import {
  approvalLabel, bandLabel, formatUptime, routerVpn, routerWifi,
} from '../../lib/devices';
import RouterLeases from './RouterLeases';

type Tab = 'dhcp' | 'wifi' | 'vpn';

const dash = (v: unknown): string =>
  v == null || v === '' ? '—' : String(v);

function RouterIdentity({ device }: { device: DeviceItem }) {
  const info = device.raw_info ?? {};
  const rows: [string, string][] = [
    ['Approval', approvalLabel(device.approval_state)],
    ['WAN MAC', dash(device.mac)],
    ['Model', dash(info.model ?? device.model)],
    ['Firmware', dash(info.firmware ?? device.version)],
    ['Hostname', dash(info.hostname)],
    ['Agent version', dash(info.agent_version)],
    ['Reporting from', dash(device.agent_source_ip)],
    ['Last seen', device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'never'],
  ];
  return (
    <div>
      <p className="set-note" style={{ padding: 0 }}>Reports are held until this router is approved.</p>
      {device.secret_mismatch && (
        <p className="set-note router-warn" style={{ padding: 0 }}>
          This MAC reported with a different secret — the router was reset, reinstalled,
          or is being impersonated. Approving trusts the newest secret.
        </p>
      )}
      <DataTable
        ariaLabel="Router identity"
        columns={[
          { key: 'field', label: 'Field', width: '160px' },
          { key: 'value', label: 'Value', mono: true },
        ]}
        rows={rows.map(([field, value]) => ({ key: field, cells: [field, value] }))}
      />
    </div>
  );
}

export default function RouterDetail({ device }: { device: DeviceItem }) {
  const [tab, setTab] = useState<Tab>('dhcp');

  if (device.approval_state && device.approval_state !== 'approved') {
    return <RouterIdentity device={device} />;
  }

  const wifi = routerWifi(device);
  const vpn = routerVpn(device);

  return (
    <div>
      <div className="lease-tabs">
        <button type="button" className="lease-tab" aria-pressed={tab === 'dhcp'}
                onClick={() => setTab('dhcp')}>DHCP clients</button>
        <button type="button" className="lease-tab" aria-pressed={tab === 'wifi'}
                onClick={() => setTab('wifi')}>WiFi ({wifi.length})</button>
        <button type="button" className="lease-tab" aria-pressed={tab === 'vpn'}
                onClick={() => setTab('vpn')}>VPN ({vpn.length})</button>
      </div>

      {tab === 'dhcp' && <RouterLeases deviceId={device.id} />}

      {tab === 'wifi' && (wifi.length === 0 ? (
        <p className="set-note" style={{ padding: 0 }}>No WiFi reported yet.</p>
      ) : (
        <DataTable
          ariaLabel="WiFi networks"
          columns={[
            { key: 'ssid', label: 'SSID' },
            { key: 'band', label: 'Band', width: '90px' },
            { key: 'channel', label: 'Channel', width: '80px', mono: true },
            { key: 'radio', label: 'Radio', mono: true },
            { key: 'state', label: 'State', width: '70px' },
            { key: 'clients', label: 'Clients', width: '70px', align: 'center' },
          ]}
          rows={wifi.map((w, i) => ({
            key: `${w.radio ?? 'radio'}-${w.ssid ?? ''}-${i}`,
            cells: [
              dash(w.ssid), bandLabel(w.band), dash(w.channel), dash(w.radio),
              w.enabled === false ? 'Off' : 'On', dash(w.clients),
            ],
          }))}
        />
      ))}

      {tab === 'vpn' && (vpn.length === 0 ? (
        <p className="set-note" style={{ padding: 0 }}>No VPN tunnels configured.</p>
      ) : (
        <DataTable
          ariaLabel="VPN tunnels"
          columns={[
            { key: 'name', label: 'Name', mono: true },
            { key: 'type', label: 'Type', width: '100px' },
            { key: 'role', label: 'Role', width: '70px' },
            { key: 'state', label: 'State', width: '90px' },
            { key: 'endpoint', label: 'Endpoint', mono: true },
            { key: 'handshake', label: 'Last handshake', width: '120px', mono: true },
          ]}
          rows={vpn.map((t, i) => ({
            key: `${t.name ?? 'vpn'}-${i}`,
            cells: [
              dash(t.name), dash(t.type), dash(t.role),
              t.enabled === false
                ? <span className="chip">Disabled</span>
                : <span className={'chip' + (t.up ? ' c-green' : ' c-red')}>{t.up ? 'Up' : 'Down'}</span>,
              dash(t.endpoint),
              t.last_handshake_seconds == null ? '—' : `${formatUptime(t.last_handshake_seconds)} ago`,
            ],
          }))}
        />
      ))}
    </div>
  );
}
