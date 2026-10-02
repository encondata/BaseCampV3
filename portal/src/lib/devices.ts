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

/** Both vocabularies: the router agent's summary (up/down/partial/none)
 *  and the older sample data's connected/disconnected. Unknown values
 *  render as-is (the column is deliberately free text). */
const VPN_LABELS: Record<string, string> = {
  up: 'Up', down: 'Down', partial: 'Partial', none: 'None',
  connected: 'Connected', disconnected: 'Disconnected',
};

export function vpnLabel(status: string | null): string {
  if (status == null) return '—';
  return VPN_LABELS[status] ?? status;
}

export function vpnChipClass(status: string | null): string {
  if (status === 'up' || status === 'connected') return ' c-green';
  if (status === 'down' || status === 'disconnected') return ' c-red';
  if (status === 'partial') return ' c-amber';
  return '';
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

/** The six values the kiosk heartbeat derives. 'zebra' is an Android
 *  handheld, so it reads as a flavor of Android rather than a platform of
 *  its own. */
const SUB_TYPE_LABELS: Record<string, string> = {
  laptop: 'Laptop', pi: 'Pi', web: 'Web', android: 'Android', ios: 'iOS',
  zebra: 'Android (Zebra)',
};

export function subTypeLabel(type: string | null): string {
  if (type == null) return '—';
  return SUB_TYPE_LABELS[type] ?? type;
}

const STATION_LABELS: Record<string, string> = { rfid: 'RFID', label: 'Label Station' };

/** The Type column text: a station kiosk reads "RFID · Laptop" / "Label
 *  Station · Laptop"; any other kiosk keeps its plain sub-type label. */
export function stationTypeLabel(d: Pick<DeviceItem, 'station_type' | 'sub_type'>): string {
  if (d.station_type == null) return subTypeLabel(d.sub_type);
  return `${STATION_LABELS[d.station_type] ?? d.station_type} \u00b7 ${subTypeLabel(d.sub_type)}`;
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

export function approvalLabel(state: string | null | undefined): string {
  if (state === 'pending') return 'Pending';
  if (state === 'approved') return 'Approved';
  if (state === 'revoked') return 'Revoked';
  return '—';
}

/** About three missed reports at the 65 s default (plus up to 10 s jitter each). */
export const ROUTER_ONLINE_MS = 4 * 60 * 1000;

export function routerStatus(
  iso: string | null | undefined, now: Date = new Date(),
): 'online' | 'offline' | 'never' {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  return now.getTime() - t <= ROUTER_ONLINE_MS ? 'online' : 'offline';
}

export function routerStatusLabel(state: ReturnType<typeof routerStatus>): string {
  return state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Never';
}

export interface RouterWifi {
  radio?: string; band?: string; ssid?: string; channel?: number | null;
  enabled?: boolean; clients?: number;
}

export interface RouterVpn {
  name?: string; type?: string; role?: string; enabled?: boolean; up?: boolean;
  endpoint?: string | null; last_handshake_seconds?: number | null;
}

function rawList<T>(d: DeviceItem, key: string): T[] {
  const v = (d.raw_info ?? {})[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export const routerWifi = (d: DeviceItem): RouterWifi[] => rawList<RouterWifi>(d, 'wifi');
export const routerVpn = (d: DeviceItem): RouterVpn[] => rawList<RouterVpn>(d, 'vpn');

/** The agent's own count when it reported one, else the up-lease count. */
export function routerClientTotal(d: DeviceItem): number {
  const c = (d.raw_info ?? {}).clients as { total?: unknown } | null | undefined;
  return typeof c?.total === 'number' ? c.total : d.connected_count;
}

const BAND_LABELS: Record<string, string> = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

export function bandLabel(band: string | null | undefined): string {
  if (!band) return '—';
  return BAND_LABELS[band] ?? band;
}

export const ROUTER_INSTALL_URL =
  'https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh';

export function routerInstallCommand(api: string): string {
  return `curl -fsSL ${ROUTER_INSTALL_URL} | sh -s -- --api ${api.replace(/\/+$/, '')}`;
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
    case 'connected':
      return String(d.device_type === 'router' ? routerClientTotal(d) : d.connected_count);
    case 'token_expires':
      return d.token_expires_at ? new Date(d.token_expires_at).toLocaleDateString() : '—';
    case 'model': return d.model ?? '—';
    case 'ip': return d.lan_ip ?? '—';
    case 'tags_24h': return String(d.tags_read_24h);
    case 'antennas': return d.antennas_connected == null ? '—' : `${d.antennas_connected} / 8`;
    case 'connection': return connectionLabel(d.connection_type);
    case 'scan_status': return d.scan_status_label ?? (d.scan_status ?? '—');
    case 'sub_type': return stationTypeLabel(d);
    case 'version': return d.version ?? '—';
    case 'current_move': return d.current_initiative_name ?? '—';
    case 'registration': return registrationLabel(tokenExpiryState(d.token_expires_at));
    case 'expires':
      return d.token_expires_at ? new Date(d.token_expires_at).toLocaleDateString() : '—';
    case 'signed_in': return d.session_person_name ?? '—';
    case 'login_method': return loginMethodLabel(d.session_login_method);
    case 'approval':
      return approvalLabel(d.approval_state) + (d.secret_mismatch ? ' · Secret changed' : '');
    case 'status': return routerStatusLabel(routerStatus(d.last_seen_at));
    default: return '';
  }
}

export function deviceSearchText(d: DeviceItem): string {
  return [
    d.name, d.wan_ip, d.lan_ip, d.mac, d.serial, d.site_name, vpnLabel(d.vpn_status),
    d.model, d.scan_status_label, d.version, stationTypeLabel(d),
    d.current_initiative_name, d.session_person_name,
  ].filter(Boolean).join(' ');
}

/** An ISO timestamp as epoch milliseconds for sorting; missing is -1, first. */
function timeValue(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : -1;
}

export function deviceSortValue(d: DeviceItem, key: string): string | number {
  switch (key) {
    case 'uptime': return d.uptime_seconds ?? -1;
    case 'last_seen': return timeValue(d.last_seen_at);
    case 'connected': return d.device_type === 'router' ? routerClientTotal(d) : d.connected_count;
    case 'status': return timeValue(d.last_seen_at);
    case 'token_expires': return timeValue(d.token_expires_at);
    case 'tags_24h': return d.tags_read_24h;
    case 'antennas': return d.antennas_connected ?? -1;
    case 'registration': return registrationLabel(tokenExpiryState(d.token_expires_at)).toLowerCase();
    case 'expires': return timeValue(d.token_expires_at);
    case 'current_move': return d.current_initiative_name ?? '';
    case 'signed_in': return d.session_person_name ?? '';
    case 'login_method': return loginMethodLabel(d.session_login_method).toLowerCase();
    default: return deviceCellText(d, key).toLowerCase();
  }
}
