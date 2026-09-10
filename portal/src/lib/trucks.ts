/**
 * Trucks page logic — pure functions the components delegate to
 * (the lib/containers.ts pattern), unit-testable without jsdom.
 */
import type { TruckDetail, TruckItem } from './api';
import { relativeTime } from './format';

export function truckSearchText(t: TruckItem): string {
  return [
    t.name, t.driver_name, t.co_driver_name, t.load_number, t.seal_id,
    t.status_label, t.initiative_name, t.start_site_name, t.end_site_name,
    t.last_update?.approximate_address,
  ].filter(Boolean).join(' ').toLowerCase();
}

/** "Ada Lovelace" solo, "Ada Lovelace + Grace Hopper" when there's a
 *  co-driver, "(team)" appended when team_drive is set on a driven truck.
 *  Empty when there's no driver at all. */
export function driversText(t: TruckItem): string {
  if (!t.driver_name) return '';
  let text = t.driver_name;
  if (t.co_driver_name) text += ` + ${t.co_driver_name}`;
  if (t.team_drive) text += ' (team)';
  return text;
}

/** relativeTime already returns 'never' for a null timestamp — this just
 *  names that behavior for the truck "last update" columns. */
export function updateAge(iso: string | null): string {
  return relativeTime(iso);
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name+load cell. */
export function truckCellText(t: TruckItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return `${t.name} ${t.load_number ?? ''}`.trim();
    case 'status': return t.status_label;
    case 'drivers': return driversText(t);
    case 'seal': return t.seal_id ?? '';
    case 'move': return t.initiative_name ?? '';
    case 'route': return `${t.start_site_name ?? '—'} → ${t.end_site_name ?? '—'}`;
    case 'last_update': return updateAge(t.last_update?.recorded_at ?? null);
    case 'containers': return String(t.container_count);
    default: return '';
  }
}

export const TRUCK_ERRORS: Record<string, string> = {
  name_required: 'Give the truck a name.',
  unknown_status: 'Pick a status from the list.',
  site_not_found: 'That site no longer exists.',
  initiative_not_found: 'That move no longer exists.',
  container_not_found: 'One of those containers no longer exists.',
  invalid_location: 'Enter a location as "lat, lng".',
  truck_not_found: 'That truck no longer exists.',
  forbidden: 'You do not have permission to change trucks.',
};

/** Same rules as api/src/serversherpa/trucks/location.py's string branch:
 *  split on exactly one comma, both parts numeric, lat -90..90, lng
 *  -180..180 — else null. */
export function parseLocationText(s: string): { lat: number; lng: number } | null {
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length !== 2 || parts.some((p) => p === '')) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/* ── edit/create form ────────────────────────────────────────────── */

export interface TruckFormState {
  name: string;
  driver_name: string;
  co_driver_name: string;
  contact_info: string;
  team_drive: boolean;
  status: string;
  load_number: string;
  seal_id: string;
  type: string;
  update_type: string;
  tracker_id: string;
  initiative_id: string;
  start_site_id: string;
  end_site_id: string;
  container_ids: string[];
}

export function formFromTruck(t: TruckDetail | null): TruckFormState {
  const tracking = t?.tracking_type ?? {};
  const trackingStr = (key: string) =>
    typeof tracking[key] === 'string' ? (tracking[key] as string) : '';
  return {
    name: t?.name ?? '',
    driver_name: t?.driver_name ?? '',
    co_driver_name: t?.co_driver_name ?? '',
    contact_info: t?.contact_info ?? '',
    team_drive: t?.team_drive ?? false,
    status: t?.status ?? 'created',
    load_number: t?.load_number ?? '',
    seal_id: t?.seal_id ?? '',
    type: trackingStr('type'),
    update_type: trackingStr('update_type'),
    tracker_id: trackingStr('tracker_id'),
    initiative_id: t?.initiative_id ?? '',
    start_site_id: t?.start_site_id ?? '',
    end_site_id: t?.end_site_id ?? '',
    container_ids: t?.containers.map((c) => c.id) ?? [],
  };
}

/** Payload for create AND patch — nulls stay in: PATCH needs them to
 *  clear fields, POST drops them server-side (exclude_none).
 *  contact_info stays '' (never null) since the column is NOT NULL. */
export function truckPayload(f: TruckFormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    out[key] = v || null;
  };
  out.name = f.name.trim();
  put('driver_name', f.driver_name);
  put('co_driver_name', f.co_driver_name);
  out.contact_info = f.contact_info.trim();
  out.team_drive = f.team_drive;
  out.status = f.status;
  put('load_number', f.load_number);
  put('seal_id', f.seal_id);

  const type = f.type.trim();
  const updateType = f.update_type.trim();
  const trackerId = f.tracker_id.trim();
  const tracking: Record<string, string> = {};
  if (type) tracking.type = type;
  if (updateType) tracking.update_type = updateType;
  if (trackerId) tracking.tracker_id = trackerId;
  out.tracking_type = tracking;

  put('initiative_id', f.initiative_id);
  put('start_site_id', f.start_site_id);
  put('end_site_id', f.end_site_id);
  out.container_ids = f.container_ids;
  return out;
}
