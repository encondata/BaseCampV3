/**
 * Initiatives page logic — pure functions the components delegate to
 * (the lib/containers.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { InitiativeItem } from './api';
import type { GodField } from './godEdit';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : '—';

export function initiativeSearchText(i: InitiativeItem): string {
  return [i.name, i.type_label, i.sub_type_label, i.status_label,
          i.client_name, i.site_name, i.location, i.origin_site_name,
          i.destination_site_name, i.sky_command_project_id]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name cell; 'archived' is the chevron pseudo-column. */
export function initiativeCellText(i: InitiativeItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return i.name;
    case 'type': return i.type_label;
    case 'sub_type': return i.sub_type_label ?? '';
    case 'status': return i.status_label;
    case 'client': return i.client_name ?? '';
    case 'site': return i.site_name ?? '';
    case 'location': return i.location || '—';
    case 'start': return day(i.scheduled_start);
    case 'end': return day(i.scheduled_end);
    case 'origin': return i.origin_site_name ?? '';
    case 'destination': return i.destination_site_name ?? '';
    case 'shipping': return i.shipping_types.join(', ') || '—';
    case 'people': return String(i.people_count);
    case 'links': return String(i.links_count);
    case 'created': return day(i.created_at);
    case 'archived': return i.archived_at ? 'Yes' : 'No';
    default: return '';
  }
}

export const INITIATIVE_ERRORS: Record<string, string> = {
  name_required: 'Name is required.',
  initiative_type_required: 'Type is required.',
  status_required: 'Status is required.',
  unknown_initiative_type: 'Pick a type from the list.',
  unknown_sub_type: 'Pick a sub-type from the list.',
  unknown_status: 'Pick a status from the list.',
  unknown_shipping_type: 'Pick shipping types from the list.',
  unknown_work_type: 'Pick a work type from the list.',
  client_not_found: 'Pick a client from the list.',
  site_not_found: 'Pick a site from the list.',
  partner_not_found: 'Pick a partner from the list.',
  person_not_found: 'That person no longer exists.',
  initiative_not_found: 'That initiative no longer exists.',
  type_change_forbidden: "Only admins can change an initiative's type.",
  duplicate_person: 'That person is already on this initiative.',
  rating_out_of_range: 'Rating must be between 1 and 5.',
  assignment_not_found: 'That assignment no longer exists.',
  self_link: 'An initiative cannot contain itself.',
  duplicate_link: 'Those initiatives are already linked.',
  circular_link: 'That link would create a loop.',
  link_not_found: 'That link no longer exists.',
  forbidden: 'You do not have permission to change initiatives.',
};

/** Which conditional form sections a type shows. */
export function sectionsForType(
  type: string,
): { project: boolean; move: boolean } {
  return { project: type === 'project', move: type === 'move' };
}

/* ── edit/create form ────────────────────────────────────────────── */

export interface InitiativeFormState {
  name: string; description: string;
  initiative_type: string; sub_type: string; status: string;
  client_id: string; site_id: string; location: string;
  scheduled_start: string; scheduled_end: string;   // YYYY-MM-DD or ''
  sky_command_project_id: string;
  origin_site_id: string; destination_site_id: string;
  real_start_at: string; real_end_at: string;       // YYYY-MM-DD or ''
  priority_devices: boolean;
  shipping_types: string[];
  shipping_partner_id: string;
  origin_tech_partner_id: string; origin_cable_partner_id: string;
  origin_logistics_partner_id: string;
  destination_tech_partner_id: string; destination_cable_partner_id: string;
  destination_logistics_partner_id: string;
  origin_vendor_involved: boolean; destination_vendor_involved: boolean;
}

const toDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

export function formFromInitiative(
  i: InitiativeItem | null,
): InitiativeFormState {
  return {
    name: i?.name ?? '',
    description: i?.description ?? '',
    initiative_type: i?.initiative_type ?? 'project',
    sub_type: i?.sub_type ?? '',
    status: i?.status ?? 'planned',
    client_id: i?.client_id ?? '',
    site_id: i?.site_id ?? '',
    location: i?.location ?? '',
    scheduled_start: toDay(i?.scheduled_start),
    scheduled_end: toDay(i?.scheduled_end),
    sky_command_project_id: i?.sky_command_project_id ?? '',
    origin_site_id: i?.origin_site_id ?? '',
    destination_site_id: i?.destination_site_id ?? '',
    real_start_at: toDay(i?.real_start_at),
    real_end_at: toDay(i?.real_end_at),
    priority_devices: i?.priority_devices ?? false,
    shipping_types: i?.shipping_types ?? [],
    shipping_partner_id: i?.shipping_partner_id ?? '',
    origin_tech_partner_id: i?.origin_tech_partner_id ?? '',
    origin_cable_partner_id: i?.origin_cable_partner_id ?? '',
    origin_logistics_partner_id: i?.origin_logistics_partner_id ?? '',
    destination_tech_partner_id: i?.destination_tech_partner_id ?? '',
    destination_cable_partner_id: i?.destination_cable_partner_id ?? '',
    destination_logistics_partner_id:
      i?.destination_logistics_partner_id ?? '',
    origin_vendor_involved: i?.origin_vendor_involved ?? false,
    destination_vendor_involved: i?.destination_vendor_involved ?? false,
  };
}

/** Payload for create AND patch — nulls stay in: PATCH needs them to
 *  clear fields, POST drops them server-side (exclude_none). Dates go
 *  as YYYY-MM-DD strings (the API parses them as midnight UTC). */
export function initiativePayload(
  form: InitiativeFormState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    out[key] = v || null;
  };
  out.name = form.name.trim();
  out.initiative_type = form.initiative_type;
  out.status = form.status;
  put('description', form.description);
  put('sub_type', form.sub_type);
  put('client_id', form.client_id);
  put('site_id', form.site_id);
  put('location', form.location);
  put('scheduled_start', form.scheduled_start);
  put('scheduled_end', form.scheduled_end);
  put('sky_command_project_id', form.sky_command_project_id);
  put('origin_site_id', form.origin_site_id);
  put('destination_site_id', form.destination_site_id);
  put('real_start_at', form.real_start_at);
  put('real_end_at', form.real_end_at);
  out.priority_devices = form.priority_devices;
  out.shipping_types = form.shipping_types;
  put('shipping_partner_id', form.shipping_partner_id);
  put('origin_tech_partner_id', form.origin_tech_partner_id);
  put('origin_cable_partner_id', form.origin_cable_partner_id);
  put('origin_logistics_partner_id', form.origin_logistics_partner_id);
  put('destination_tech_partner_id', form.destination_tech_partner_id);
  put('destination_cable_partner_id', form.destination_cable_partner_id);
  put('destination_logistics_partner_id',
      form.destination_logistics_partner_id);
  out.origin_vendor_involved = form.origin_vendor_involved;
  out.destination_vendor_involved = form.destination_vendor_involved;
  return out;
}

/* ── god-edit descriptors (lib/containers.ts factory pattern) ────── */

export interface InitiativeGodLookups {
  clients: () => ComboOption[];
  sites: () => ComboOption[];
  statuses: () => ComboOption[];
  types: () => ComboOption[];
  subTypes: () => ComboOption[];
}

export function INITIATIVE_GOD_FIELDS(
  lookups: InitiativeGodLookups,
): GodField<InitiativeItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (i) => i.name },
    { column: 'location', field: 'location', kind: 'text',
      fromRow: (i) => i.location ?? '' },
    { column: 'type', field: 'initiative_type', kind: 'combo',
      fromRow: (i) => i.initiative_type, options: lookups.types },
    { column: 'sub_type', field: 'sub_type', kind: 'combo',
      fromRow: (i) => i.sub_type ?? '', options: lookups.subTypes },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (i) => i.status, options: lookups.statuses },
    { column: 'client', field: 'client_id', kind: 'combo',
      fromRow: (i) => i.client_id ?? '', options: lookups.clients },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (i) => i.site_id ?? '', options: lookups.sites },
  ];
}
