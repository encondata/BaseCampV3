/**
 * Containers page logic — pure functions the components delegate to
 * (the lib/assets.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { ContainerItem } from './api';
import { displayRfid } from './format';
import type { GodField } from './godEdit';

export function containerSearchText(c: ContainerItem): string {
  return [c.name, c.rfid_tag, c.type_label, c.status_label,
          c.site_name, c.location_detail]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name cell; 'archived' is the chevron pseudo-column. */
export function containerCellText(c: ContainerItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return c.name;
    case 'type': return c.type_label ?? '';
    case 'rfid': return displayRfid(c.rfid_tag);
    case 'assets': return String(c.asset_count);
    case 'status': return c.status_label;
    case 'site': return c.site_name ?? '';
    case 'initiative': return c.initiative_name ?? '';
    case 'location': return c.location_detail || '—';
    case 'updated': return c.created_at ? new Date(c.created_at).toLocaleDateString() : '—';
    case 'archived': return c.archived_at ? 'Yes' : 'No';
    default: return '';
  }
}

export const CONTAINER_ERRORS: Record<string, string> = {
  rfid_tag_in_use: 'That RFID tag is already on another container.',
  site_not_found: 'Pick a site from the list.',
  unknown_status: 'Pick a status from the list.',
  unknown_container_type: 'Pick a container type from the list.',
  name_required: 'Name is required.',
  location_detail_required: 'Location cannot be null.',
  status_required: 'Status is required.',
  asset_not_found: 'One of those assets no longer exists.',
  assets_in_containers: 'Some assets are already in another container.',
  membership_not_found: 'That asset is not in this container.',
  forbidden: 'You do not have permission to change containers.',
};

/* ── edit/create form ────────────────────────────────────────────── */

export interface ContainerFormState {
  name: string; rfid_tag: string; container_type: string;
  status: string; site_id: string; location_detail: string;
}

export function formFromContainer(c: ContainerItem | null): ContainerFormState {
  return {
    name: c?.name ?? '',
    rfid_tag: c?.rfid_tag ?? '',
    container_type: c?.container_type ?? '',
    status: c?.status ?? 'available',
    site_id: c?.site_id ?? '',
    location_detail: c?.location_detail ?? '',
  };
}

/** Payload for create AND patch — nulls stay in: PATCH needs them to
 *  clear fields, POST drops them server-side (exclude_none). */
export function containerPayload(
  form: ContainerFormState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    out[key] = v || null;
  };
  out.name = form.name.trim();
  put('rfid_tag', form.rfid_tag);
  put('container_type', form.container_type);
  put('site_id', form.site_id);
  out.location_detail = form.location_detail.trim();
  out.status = form.status;
  return out;
}

/* ── god-edit descriptors (lib/assets.ts factory pattern) ────────── */

export interface ContainerGodLookups {
  sites: () => ComboOption[];
  statuses: () => ComboOption[];
  types: () => ComboOption[];
}

export function CONTAINER_GOD_FIELDS(
  lookups: ContainerGodLookups,
): GodField<ContainerItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (c) => c.name },
    { column: 'rfid', field: 'rfid_tag', kind: 'text',
      fromRow: (c) => c.rfid_tag ?? '' },
    { column: 'location', field: 'location_detail', kind: 'text',
      fromRow: (c) => c.location_detail },
    { column: 'type', field: 'container_type', kind: 'combo',
      fromRow: (c) => c.container_type ?? '', options: lookups.types },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (c) => c.site_id ?? '', options: lookups.sites },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (c) => c.status, options: lookups.statuses },
  ];
}
