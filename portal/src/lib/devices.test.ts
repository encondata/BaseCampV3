import { describe, expect, it } from 'vitest';

import type { DeviceItem } from './api';
import {
  deviceCellText, deviceSearchText, deviceSortValue, formatUptime,
  tokenExpiryState, vpnLabel,
} from './devices';

const R: DeviceItem = {
  id: 'd1', device_type: 'router', name: 'dock-router-1',
  serial: 'GL-MT300N-C4A1B2', mac: '94:83:C4:12:A1:B2',
  site_id: 's1', site_name: 'NAP 11',
  wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
  uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T10:00:00Z',
  raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
  vpn_status: null, token_expires_at: null, connected_count: 0,
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
    expect(deviceSortValue(r2, 'token_expires')).toBe('2026-11-29T00:00:00Z');
    expect(deviceSortValue({ ...r2, token_expires_at: null }, 'token_expires')).toBe('');
  });
});
