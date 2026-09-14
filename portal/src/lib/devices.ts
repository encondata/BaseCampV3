/** Pure display helpers for the device-fleet lists. cellText mirrors
 *  the rendered cell text exactly (house search/CSV contract). */

import type { DeviceItem } from './api';

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return '<1m';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function vpnLabel(status: string | null): string {
  if (status == null) return '—';
  if (status === 'connected') return 'Connected';
  if (status === 'disconnected') return 'Disconnected';
  return status;
}

export function connectionLabel(type: string | null): string {
  if (type == null) return '—';
  if (type === 'api') return 'API';
  if (type === 'mqtt') return 'MQTT';
  if (type === 'local_api') return 'Local API';
  return type;
}

const SOON_MS = 7 * 24 * 3600 * 1000;

export function tokenExpiryState(
  iso: string | null | undefined, now: Date = new Date(),
): 'none' | 'expired' | 'soon' | 'ok' {
  if (!iso) return 'none';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'none';
  if (t <= now.getTime()) return 'expired';
  return t - now.getTime() <= SOON_MS ? 'soon' : 'ok';
}

const SUB_TYPE_LABELS: Record<string, string> = {
  laptop: 'Laptop', pi: 'Pi', web: 'Web', android: 'Android', ios: 'iOS', zebra: 'Zebra',
};

export function subTypeLabel(type: string | null): string {
  if (type == null) return '—';
  return SUB_TYPE_LABELS[type] ?? type;
}

export function registrationLabel(state: ReturnType<typeof tokenExpiryState>): string {
  if (state === 'ok') return 'Registered';
  if (state === 'soon') return 'Expires soon';
  if (state === 'expired') return 'Expired';
  return 'Unregistered';
}

export function loginMethodLabel(m: string | null): string {
  if (m == null) return '—';
  if (m === 'password') return 'Password';
  if (m === 'link') return 'Phone link';
  return m;
}

export function deviceCellText(d: DeviceItem, key: string): string {
  switch (key) {
    case 'name': return d.name;
    case 'wan_ip': return d.wan_ip ?? '—';
    case 'lan_ip': return d.lan_ip ?? '—';
    case 'mac': return d.mac ?? '—';
    case 'serial': return d.serial ?? '—';
    case 'uptime': return formatUptime(d.uptime_seconds);
    case 'last_seen':
      return d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
    case 'site': return d.site_name ?? '—';
    case 'vpn': return vpnLabel(d.vpn_status);
    case 'connected': return String(d.connected_count);
    case 'token_expires':
      return d.token_expires_at ? new Date(d.token_expires_at).toLocaleDateString() : '—';
    case 'model': return d.model ?? '—';
    case 'ip': return d.lan_ip ?? '—';
    case 'tags_24h': return String(d.tags_read_24h);
    case 'antennas': return d.antennas_connected == null ? '—' : `${d.antennas_connected} / 8`;
    case 'connection': return connectionLabel(d.connection_type);
    case 'scan_status': return d.scan_status_label ?? (d.scan_status ?? '—');
    case 'sub_type': return subTypeLabel(d.sub_type);
    case 'version': return d.version ?? '—';
    case 'current_move': return d.current_initiative_name ?? '—';
    case 'registration': return registrationLabel(tokenExpiryState(d.token_expires_at));
    case 'expires':
      return d.token_expires_at ? new Date(d.token_expires_at).toLocaleDateString() : '—';
    case 'signed_in': return d.session_person_name ?? '—';
    case 'login_method': return loginMethodLabel(d.session_login_method);
    default: return '';
  }
}

export function deviceSearchText(d: DeviceItem): string {
  return [
    d.name, d.wan_ip, d.lan_ip, d.mac, d.serial, d.site_name, vpnLabel(d.vpn_status),
    d.model, d.scan_status_label, d.version, subTypeLabel(d.sub_type),
    d.current_initiative_name, d.session_person_name,
  ].filter(Boolean).join(' ');
}

export function deviceSortValue(d: DeviceItem, key: string): string | number {
  switch (key) {
    case 'uptime': return d.uptime_seconds ?? -1;
    case 'last_seen': return d.last_seen_at ?? '';
    case 'connected': return d.connected_count;
    case 'token_expires': return d.token_expires_at ?? '';
    case 'tags_24h': return d.tags_read_24h;
    case 'antennas': return d.antennas_connected ?? -1;
    case 'registration': return registrationLabel(tokenExpiryState(d.token_expires_at)).toLowerCase();
    case 'expires': return d.token_expires_at ?? '';
    case 'current_move': return d.current_initiative_name ?? '';
    case 'signed_in': return d.session_person_name ?? '';
    case 'login_method': return loginMethodLabel(d.session_login_method).toLowerCase();
    default: return deviceCellText(d, key).toLowerCase();
  }
}
