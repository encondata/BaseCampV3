// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem } from '../../lib/api';

const api = vi.hoisted(() => ({ listDeviceLeases: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: RouterDetail } = await import('./RouterDetail');

const router = (over: Partial<DeviceItem> = {}): DeviceItem => ({
  id: 'r1', device_type: 'router', name: 'dock-router', serial: null, mac: '94:83:c4:aa:bb:cc',
  site_id: null, site_name: null, wan_ip: '203.0.113.7', lan_ip: '192.168.8.1',
  uptime_seconds: 100, last_seen_at: '2026-10-01T12:00:00Z',
  raw_info: {
    model: 'GL.iNet GL-MT3000', firmware: '4.5.0', hostname: 'GL-MT3000-1a2', agent_version: '1.0.0',
    wifi: [
      { radio: 'radio0', band: '2g', ssid: 'Site-WiFi', channel: 6, enabled: true, clients: 4 },
      { radio: 'radio0', band: '2g', ssid: 'Guest', channel: null, enabled: false, clients: 0 },
    ],
    vpn: [{ name: 'wgclient', type: 'wireguard', role: 'client', enabled: true, up: true,
            endpoint: '198.51.100.10:51820', last_handshake_seconds: 42 }],
  },
  registered_at: '2026-10-01T00:00:00Z', vpn_status: 'up', token_expires_at: null,
  connected_count: 0, model: 'GL.iNet GL-MT3000', antennas_connected: null, connection_type: null,
  scan_status: null, scan_status_label: null, scan_status_color: null, tags_read_24h: 0,
  version: '4.5.0', sub_type: null, current_initiative_id: null, current_initiative_name: null,
  session_person_id: null, session_person_name: null, session_login_method: null,
  session_started_at: null, setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  approval_state: 'approved', secret_mismatch: false, agent_source_ip: '203.0.113.7',
  ...over,
});

beforeEach(() => { api.listDeviceLeases.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('approved router: DHCP tab first, then WiFi and VPN tables', async () => {
  const user = userEvent.setup();
  render(<RouterDetail device={router()} />);
  expect(screen.getByRole('button', { name: 'DHCP clients' }).getAttribute('aria-pressed')).toBe('true');
  expect(await screen.findByText('No active leases.')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'WiFi (2)' }));
  expect(screen.getByText('Site-WiFi')).toBeTruthy();
  expect(screen.getAllByText('2.4 GHz')).toHaveLength(2);
  expect(screen.getByText('Off')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'VPN (1)' }));
  expect(screen.getByText('wgclient')).toBeTruthy();
  expect(screen.getByText('198.51.100.10:51820')).toBeTruthy();
  expect(screen.getByText('Up')).toBeTruthy();
});

it('a held router shows identity only and says reports are held', () => {
  render(<RouterDetail device={router({ approval_state: 'pending', secret_mismatch: true })} />);
  expect(screen.getByText('Reports are held until this router is approved.')).toBeTruthy();
  expect(screen.getByText(/reported with a different secret/)).toBeTruthy();
  expect(screen.getByText('94:83:c4:aa:bb:cc')).toBeTruthy();
  expect(screen.getByText('GL-MT3000-1a2')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'DHCP clients' })).toBeNull();
  expect(api.listDeviceLeases).not.toHaveBeenCalled();
});

it('empty WiFi/VPN tabs say so', async () => {
  const user = userEvent.setup();
  render(<RouterDetail device={router({ raw_info: {} })} />);
  await user.click(screen.getByRole('button', { name: 'WiFi (0)' }));
  expect(screen.getByText('No WiFi reported yet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'VPN (0)' }));
  expect(screen.getByText('No VPN tunnels configured.')).toBeTruthy();
});
