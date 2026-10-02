import { describe, expect, it } from 'vitest';

import type { DeviceItem } from './api';
import {
  connectionLabel, deviceCellText, deviceSearchText, deviceSortValue, formatUptime,
  loginMethodLabel, registrationLabel, subTypeLabel, tokenExpiryState, vpnLabel,
  approvalLabel, bandLabel, routerClientTotal, routerInstallCommand,
  routerStatus, routerVpn, routerWifi, vpnChipClass,
} from './devices';

const R: DeviceItem = {
  id: 'd1', device_type: 'router', name: 'dock-router-1',
  serial: 'GL-MT300N-C4A1B2', mac: '94:83:C4:12:A1:B2',
  site_id: 's1', site_name: 'NAP 11',
  wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
  uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T10:00:00Z',
  raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
  vpn_status: null, token_expires_at: null, connected_count: 0,
  model: null, antennas_connected: null, connection_type: null,
  scan_status: null, scan_status_label: null, scan_status_color: null,
  tags_read_24h: 0,
  version: null, sub_type: null,
  current_initiative_id: null, current_initiative_name: null,
  session_person_id: null, session_person_name: null,
  session_login_method: null, session_started_at: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
};

describe('formatUptime', () => {
  it('humanizes', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(45)).toBe('<1m');
    expect(formatUptime(45 * 60)).toBe('45m');
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3h 12m');
    expect(formatUptime(1_036_800)).toBe('12d 0h');
  });
});

describe('device accessors', () => {
  it('cellText mirrors display fields', () => {
    expect(deviceCellText(R, 'name')).toBe('dock-router-1');
    expect(deviceCellText(R, 'wan_ip')).toBe('203.0.113.14');
    expect(deviceCellText(R, 'lan_ip')).toBe('192.168.8.1');
    expect(deviceCellText(R, 'mac')).toBe('94:83:C4:12:A1:B2');
    expect(deviceCellText(R, 'serial')).toBe('GL-MT300N-C4A1B2');
    expect(deviceCellText(R, 'uptime')).toBe('12d 0h');
    expect(deviceCellText(R, 'site')).toBe('NAP 11');
    expect(deviceCellText({ ...R, wan_ip: null }, 'wan_ip')).toBe('—');
    expect(deviceCellText({ ...R, last_seen_at: null }, 'last_seen')).toBe('never');
  });
  it('searchText covers name/ips/mac/serial/site', () => {
    const hay = deviceSearchText(R).toLowerCase();
    for (const bit of ['dock-router-1', '203.0.113.14', '192.168.8.1',
                       '94:83:c4:12:a1:b2', 'gl-mt300n-c4a1b2', 'nap 11']) {
      expect(hay).toContain(bit);
    }
  });
  it('sortValue is numeric for uptime', () => {
    expect(deviceSortValue(R, 'uptime')).toBe(1_036_800);
    expect(deviceSortValue({ ...R, uptime_seconds: null }, 'uptime')).toBe(-1);
    expect(deviceSortValue(R, 'name')).toBe('dock-router-1');
  });
});

describe('vpnLabel', () => {
  it('maps known values, passes through others', () => {
    expect(vpnLabel('connected')).toBe('Connected');
    expect(vpnLabel('disconnected')).toBe('Disconnected');
    expect(vpnLabel('wg-handshake-stale')).toBe('wg-handshake-stale');
    expect(vpnLabel(null)).toBe('—');
  });
});

describe('tokenExpiryState', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  it('classifies', () => {
    expect(tokenExpiryState(null, now)).toBe('none');
    expect(tokenExpiryState('2026-08-30T00:00:00Z', now)).toBe('expired');
    expect(tokenExpiryState('2026-09-03T00:00:00Z', now)).toBe('soon');
    expect(tokenExpiryState('2026-11-29T00:00:00Z', now)).toBe('ok');
  });
});

describe('new cell accessors', () => {
  const r2 = { ...R, vpn_status: 'connected', connected_count: 4,
               token_expires_at: '2026-11-29T00:00:00Z' };
  it('cellText for vpn/connected/token_expires', () => {
    expect(deviceCellText(r2, 'vpn')).toBe('Connected');
    expect(deviceCellText(r2, 'connected')).toBe('4');
    expect(deviceCellText(r2, 'token_expires'))
      .toBe(new Date('2026-11-29T00:00:00Z').toLocaleDateString());
    expect(deviceCellText({ ...r2, token_expires_at: null }, 'token_expires')).toBe('—');
  });
  it('sortValue numeric for connected, iso for token', () => {
    expect(deviceSortValue(r2, 'connected')).toBe(4);
    expect(deviceSortValue(r2, 'token_expires')).toBe(Date.parse('2026-11-29T00:00:00Z'));
    expect(deviceSortValue({ ...r2, token_expires_at: null }, 'token_expires')).toBe(-1);
  });
});

describe('connectionLabel', () => {
  it('maps known, passes through unknown', () => {
    expect(connectionLabel('api')).toBe('API');
    expect(connectionLabel('mqtt')).toBe('MQTT');
    expect(connectionLabel('local_api')).toBe('Local API');
    expect(connectionLabel('serial-console')).toBe('serial-console');
    expect(connectionLabel(null)).toBe('—');
  });
});

describe('reader cell accessors', () => {
  const fr = { ...R, model: 'FX9600', antennas_connected: 4,
               connection_type: 'mqtt', scan_status: 'rfid_1_cage_exit',
               scan_status_label: 'RFID 1 - Cage Exit',
               scan_status_color: '#31F527', tags_read_24h: 152 };
  it('cellText for the reader keys', () => {
    expect(deviceCellText(fr, 'model')).toBe('FX9600');
    expect(deviceCellText(fr, 'ip')).toBe('192.168.8.1');
    expect(deviceCellText(fr, 'tags_24h')).toBe('152');
    expect(deviceCellText(fr, 'antennas')).toBe('4 / 8');
    expect(deviceCellText(fr, 'connection')).toBe('MQTT');
    expect(deviceCellText(fr, 'scan_status')).toBe('RFID 1 - Cage Exit');
    expect(deviceCellText({ ...fr, antennas_connected: null }, 'antennas')).toBe('—');
    expect(deviceCellText({ ...fr, scan_status: null, scan_status_label: null },
                          'scan_status')).toBe('—');
  });
  it('sortValue numeric for tags/antennas', () => {
    expect(deviceSortValue(fr, 'tags_24h')).toBe(152);
    expect(deviceSortValue(fr, 'antennas')).toBe(4);
    expect(deviceSortValue({ ...fr, antennas_connected: null }, 'antennas')).toBe(-1);
  });
});

// tokenExpiryState's 'registration'/'expires' cellText below computes off
// real `now` (no override), so fixture dates must stay time-proof — ~50
// years out/back — rather than the near-future/near-past dates other
// describe blocks above use with an explicit `now`.
describe('kiosk accessors', () => {
  const k = {
    ...R, sub_type: 'pi', version: '2.4.1',
    current_initiative_id: 'i1',
    current_initiative_name: 'NAP11 Hall Migration (demo)',
    token_expires_at: '2076-11-29T00:00:00Z',
  };
  it('labels', () => {
    expect(subTypeLabel('laptop')).toBe('Laptop');
    expect(subTypeLabel('pi')).toBe('Pi');
    expect(subTypeLabel('android')).toBe('Android');
    expect(subTypeLabel('ios')).toBe('iOS');
    // A Zebra handheld IS an Android kiosk — the label says so rather than
    // reading as a separate platform next to 'Android'.
    expect(subTypeLabel('zebra')).toBe('Android (Zebra)');
    expect(subTypeLabel(null)).toBe('—');
    expect(registrationLabel('ok')).toBe('Registered');
    expect(registrationLabel('soon')).toBe('Expires soon');
    expect(registrationLabel('expired')).toBe('Expired');
    expect(registrationLabel('none')).toBe('Unregistered');
  });
  it('cellText', () => {
    expect(deviceCellText(k, 'sub_type')).toBe('Pi');
    expect(deviceCellText(k, 'version')).toBe('2.4.1');
    expect(deviceCellText(k, 'current_move')).toBe('NAP11 Hall Migration (demo)');
    expect(deviceCellText({ ...k, current_initiative_name: null }, 'current_move')).toBe('—');
    expect(deviceCellText(k, 'registration')).toBe('Registered');
    expect(deviceCellText({ ...k, token_expires_at: null }, 'registration')).toBe('Unregistered');
    expect(deviceCellText(k, 'expires'))
      .toBe(new Date('2076-11-29T00:00:00Z').toLocaleDateString());
  });
  it('sortValue', () => {
    expect(deviceSortValue(k, 'registration')).toBe('registered');
    expect(deviceSortValue(k, 'expires')).toBe(Date.parse('2076-11-29T00:00:00Z'));
    expect(deviceSortValue({ ...k, token_expires_at: null }, 'expires')).toBe(-1);
    expect(deviceSortValue(k, 'current_move')).toBe('NAP11 Hall Migration (demo)');
    expect(deviceSortValue({ ...k, current_initiative_name: null }, 'current_move')).toBe('');
    expect(deviceSortValue(k, 'sub_type')).toBe('pi');
    expect(deviceSortValue(k, 'version')).toBe('2.4.1');
  });
  it('deviceSearchText includes version/kiosk type/current move', () => {
    const hay = deviceSearchText(k).toLowerCase();
    expect(hay).toContain('2.4.1');
    expect(hay).toContain('pi');
    expect(hay).toContain('nap11 hall migration (demo)');
  });

  it('labels the web kiosk sub-type', () => {
    expect(subTypeLabel('web')).toBe('Web');
  });
});

describe('kiosk session accessors', () => {
  const signedIn = {
    ...R, session_person_id: 'p1', session_person_name: 'Claude Dev',
    session_login_method: 'link', session_started_at: '2026-09-13T10:00:00Z',
  };

  it('loginMethodLabel maps known values, passes through unknown, dashes null', () => {
    expect(loginMethodLabel('password')).toBe('Password');
    expect(loginMethodLabel('link')).toBe('Phone link');
    expect(loginMethodLabel('badge')).toBe('badge');
    expect(loginMethodLabel(null)).toBe('—');
  });

  it('cellText for signed_in/login_method', () => {
    expect(deviceCellText(signedIn, 'signed_in')).toBe('Claude Dev');
    expect(deviceCellText(signedIn, 'login_method')).toBe('Phone link');
    expect(deviceCellText({ ...R, session_person_name: null }, 'signed_in')).toBe('—');
    expect(deviceCellText({ ...R, session_login_method: null }, 'login_method')).toBe('—');
  });

  it('sortValue for signed_in/login_method', () => {
    expect(deviceSortValue(signedIn, 'signed_in')).toBe('Claude Dev');
    expect(deviceSortValue({ ...R, session_person_name: null }, 'signed_in')).toBe('');
    expect(deviceSortValue(signedIn, 'login_method')).toBe('phone link');
  });

  it('deviceSearchText includes the signed-in person', () => {
    expect(deviceSearchText(signedIn).toLowerCase()).toContain('claude dev');
    expect(deviceSearchText({ ...R, session_person_name: null }).toLowerCase())
      .not.toContain('claude dev');
  });
});

const base: DeviceItem = { ...R, id: 'r1', site_id: null, site_name: null, wan_ip: null,
  lan_ip: null, uptime_seconds: null, last_seen_at: null, connected_count: 2 };

describe('router helpers', () => {
  it('labels approval states and adds the secret-changed note to the cell text', () => {
    expect(approvalLabel('pending')).toBe('Pending');
    expect(approvalLabel('approved')).toBe('Approved');
    expect(approvalLabel('revoked')).toBe('Revoked');
    expect(approvalLabel(null)).toBe('—');
    expect(deviceCellText({ ...base, approval_state: 'pending', secret_mismatch: true }, 'approval'))
      .toBe('Pending · Secret changed');
  });

  it('online within 4 minutes, offline after, never without a check-in', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(routerStatus('2026-10-01T11:57:00Z', now)).toBe('online');
    expect(routerStatus('2026-10-01T11:56:00Z', now)).toBe('online');
    expect(routerStatus('2026-10-01T11:55:59Z', now)).toBe('offline');
    expect(routerStatus(null, now)).toBe('never');
  });

  it('maps both VPN vocabularies to labels and chips', () => {
    expect(vpnLabel('up')).toBe('Up');
    expect(vpnLabel('partial')).toBe('Partial');
    expect(vpnLabel('none')).toBe('None');
    expect(vpnLabel('connected')).toBe('Connected');
    expect(vpnChipClass('up')).toBe(' c-green');
    expect(vpnChipClass('connected')).toBe(' c-green');
    expect(vpnChipClass('down')).toBe(' c-red');
    expect(vpnChipClass('partial')).toBe(' c-amber');
    expect(vpnChipClass('none')).toBe('');
  });

  it('reads wifi/vpn/clients out of raw_info defensively', () => {
    const d = { ...base, raw_info: {
      wifi: [{ ssid: 'Site', band: '5g' }], vpn: [{ name: 'wg' }], clients: { total: 7 },
    } };
    expect(routerWifi(d)).toEqual([{ ssid: 'Site', band: '5g' }]);
    expect(routerVpn(d)).toEqual([{ name: 'wg' }]);
    expect(routerClientTotal(d)).toBe(7);
    expect(deviceCellText(d, 'connected')).toBe('7');
    expect(routerWifi({ ...base, raw_info: { wifi: 'nope' } })).toEqual([]);
    expect(routerClientTotal(base)).toBe(2); // falls back to the lease count
    expect(bandLabel('2g')).toBe('2.4 GHz');
    expect(bandLabel('6g')).toBe('6 GHz');
    expect(bandLabel(undefined)).toBe('—');
  });

  it('builds the one-line install command', () => {
    expect(routerInstallCommand('https://api.example.com/')).toBe(
      'curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh'
      + ' | sh -s -- --api https://api.example.com',
    );
  });
});
