/**
 * Initiatives page logic — pure functions the components delegate to
 * (the lib/containers.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type {
  InitiativeAssetRow, InitiativeItem, OrgRef, SiteItem, StatusValue,
} from './api';
import { boolTriToPatch, numberToPatch, type GodField } from './godEdit';
import type { ColumnDef } from './listTools';
import { displayRfid } from './format';
import { parseApiDay } from './timeline';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : '—';

/** Date-only fields (start/end) are stored as midnight UTC for a plain
 *  YYYY-MM-DD user input — rendering them with local-time toLocaleDateString
 *  shifts a day west of UTC (e.g. Denver sees 8/31 for 9/1). Slice the ISO
 *  string instead, matching the edit modal's round-trip (lib/initiatives.ts
 *  toDay). */
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export function initiativeSearchText(i: InitiativeItem): string {
  return [i.name, i.type_label, i.sub_type_label, i.status_label,
          i.client_name, i.site_name, i.location, i.origin_site_name,
          i.destination_site_name, i.sky_command_project_id]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name cell; 'archived' is the chevron pseudo-column.
 *  `shippingLabels` maps shipping_type vocab keys to their labels (the page
 *  builds it from the fetched status-values); unknown keys fall back raw. */
export function initiativeCellText(
  i: InitiativeItem, colKey: string,
  shippingLabels: Record<string, string> = {},
): string {
  switch (colKey) {
    case 'primary': return i.name;
    case 'type': return i.type_label;
    case 'sub_type': return i.sub_type_label ?? '';
    case 'status': return i.status_label;
    case 'client': return i.client_name ?? '';
    case 'site': return i.site_name ?? '';
    case 'location': return i.location || '—';
    case 'start': return dateOnly(i.scheduled_start);
    case 'end': return dateOnly(i.scheduled_end);
    case 'origin': return i.origin_site_name ?? '';
    case 'destination': return i.destination_site_name ?? '';
    case 'shipping':
      return i.shipping_types.map((k) => shippingLabels[k] ?? k).join(', ')
        || '—';
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
  already_has_parent: 'That initiative is already inside another one. Remove the existing link first.',
  circular_link: 'That link would create a loop.',
  link_not_found: 'That link no longer exists.',
  forbidden: 'You do not have permission to change initiatives.',
};

/** Site options for the edit modal's site pickers. With a client selected,
 *  that client's assigned sites list first (tagged "Client site") — but every
 *  site stays typeable/selectable. Archived sites are hidden unless one is
 *  the field's current value (`keepId`). */
export function siteOptionsForClient(
  sites: SiteItem[], clientId: string, keepId?: string,
): ComboOption[] {
  const usable = sites.filter((s) => !s.archived_at || s.id === keepId);
  const isAssigned = (s: SiteItem) =>
    s.clients.some((c) => c.client_id === clientId);
  if (!clientId || !usable.some(isAssigned)) {
    return usable.map((s) => ({ value: s.id, label: s.name }));
  }
  return [
    ...usable.filter(isAssigned)
      .map((s) => ({ value: s.id, label: s.name, sub: 'Client site' })),
    ...usable.filter((s) => !isAssigned(s))
      .map((s) => ({ value: s.id, label: s.name })),
  ];
}

/** Partner options for a role-specific picker (tech / cable / logistics /
 *  shipping). Partners whose free-form function tags match the role's
 *  keywords list first — tagged with the matching function — but every
 *  partner stays typeable/selectable. Archived partners are hidden unless
 *  one is the field's current value (`keepId`). */
export function partnerOptionsForRole(
  partners: OrgRef[], roleKeywords: string[], keepId?: string,
): ComboOption[] {
  const usable = partners.filter((p) => !p.archived_at || p.id === keepId);
  const matchTag = (p: OrgRef) =>
    (p.partner_types ?? []).find((t) =>
      roleKeywords.some((k) => t.toLowerCase().includes(k.toLowerCase())));
  if (!usable.some((p) => matchTag(p) !== undefined)) {
    return usable.map((p) => ({ value: p.id, label: p.name }));
  }
  return [
    ...usable.filter((p) => matchTag(p) !== undefined)
      .map((p) => ({ value: p.id, label: p.name, sub: matchTag(p) })),
    ...usable.filter((p) => matchTag(p) === undefined)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
}

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
  color: string;                                    // '#rrggbb' or ''
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
    // '' stays "never colored": the modal shows the status color in the
    // wheel, but only a deliberate spin writes a color to the row
    color: i?.color ?? '',
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
  // blank → null: on POST the API drops it and assigns the next palette
  // color, on PATCH it clears back to status coloring
  put('color', form.color);
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

/* ── move assets — Full Details page asset roster (v2 MoveDetail parity,
      docs/superpowers/specs/2026-08-25-move-assets-design.md). Read-only
      table this slice (Task 3); edit dialog + remove land in Task 4. ── */

const BLANK = '—';

/** Default columns mirror v2's MoveDetail grid; optional columns are the
 *  remaining per-move + asset fields, offered via the Columns picker.
 *  `min` floors on the nine defaults are sized so that, with the 88px
 *  actions track, the 30px chevron track, ten 12px gaps, and 40px of
 *  padding, the row minimum is 1134px — exactly LIST_FIT.initPanel, what
 *  the initiative detail page's .init-panel gives a list in a 14-inch
 *  MacBook Pro window with the nav expanded (1512px viewport, 248px nav,
 *  44px page padding, 18px panel padding and a 1px panel border each
 *  side; spec 2026-09-23-list-column-floors). `short`
 *  is the header shown once the long label would overflow its track.
 *  Optional columns take the derived floor. */
export const MOVE_ASSET_COLUMNS: ColumnDef[] = [
  { key: 'asset_id', label: 'Asset ID', width: '0.8fr', default: true, min: 90 },
  { key: 'asset_name', label: 'Asset Name', width: '1.3fr', default: true, min: 120 },
  { key: 'serial', label: 'Serial', width: '1.1fr', default: true, min: 100 },
  { key: 'make_model', label: 'Make/Model', width: '1.2fr', default: true, min: 104 },
  { key: 'status', label: 'Status', width: '1.1fr', default: true, min: 90 },
  { key: 'source_rack', label: 'Source Rack', short: 'Src Rack', width: '1fr', default: true, min: 92 },
  { key: 'source_ru', label: 'Source RU', short: 'Src RU', width: '0.8fr', default: true, min: 76 },
  { key: 'destination_rack', label: 'Destination Rack', short: 'Dest Rack', width: '1fr', default: true, min: 100 },
  { key: 'destination_ru', label: 'Destination RU', short: 'Dest RU', width: '0.9fr', default: true, min: 84 },
  { key: 'wave', label: 'Wave', width: '0.8fr', default: false },
  { key: 'disposition', label: 'Disposition', width: '1.1fr', default: false },
  { key: 'owner', label: 'Owner', width: '1fr', default: false },
  { key: 'source_verified', label: 'Source Verified', short: 'Src Verified', width: '0.9fr', default: false },
  { key: 'source_position', label: 'Source Position', short: 'Src Position', width: '1fr', default: false },
  { key: 'source_pod', label: 'Source Pod', short: 'Src Pod', width: '0.8fr', default: false },
  { key: 'destination_verified', label: 'Destination Verified', short: 'Dest Verified', width: '1fr', default: false },
  { key: 'destination_position', label: 'Destination Position', short: 'Dest Position', width: '1.1fr', default: false },
  { key: 'destination_pod', label: 'Destination Pod', short: 'Dest Pod', width: '0.9fr', default: false },
  { key: 'cable_info', label: 'Cable Info', width: '1.2fr', default: false },
  { key: 'vendor_involved', label: 'Vendor Involved', short: 'Vendor', width: '1fr', default: false },
  { key: 'asset_status', label: 'Asset Status', width: '1.1fr', default: false },
  { key: 'rfid_tag', label: 'RFID Tag', width: '1fr', default: false },
  { key: 'location', label: 'Location', width: '1.1fr', default: false },
  { key: 'pod_number', label: 'Pod #', width: '0.7fr', default: false },
  { key: 'client', label: 'Client', width: '1fr', default: false },
  { key: 'added', label: 'Added', width: '0.9fr', default: false },
  { key: 'updated', label: 'Updated', width: '0.9fr', default: false },
];

const yesNo = (v: boolean | null): string => (v == null ? BLANK : v ? 'Yes' : 'No');
const dayOf = (iso: string) => new Date(iso).toLocaleDateString();

/** Column-menu accessor — one row's display text per column key (feeds
 *  sort/filter/search AND CSV export). Every missing value — text, RU
 *  number, or boolean — collapses to the same '—' blank marker. */
export function moveAssetCellText(row: InitiativeAssetRow, colKey: string): string {
  switch (colKey) {
    case 'asset_id':
      return row.asset.legacy_id != null ? String(row.asset.legacy_id) : BLANK;
    case 'asset_name': return row.asset.name ?? BLANK;
    case 'serial': return row.asset.serial_number ?? BLANK;
    case 'make_model':
      return [row.asset.model_make, row.asset.model_name]
        .filter(Boolean).join(' ') || BLANK;
    case 'status': return row.status_label;
    case 'source_rack': return row.source_rack ?? BLANK;
    case 'source_ru': return row.source_ru != null ? String(row.source_ru) : BLANK;
    case 'destination_rack': return row.destination_rack ?? BLANK;
    case 'destination_ru':
      return row.destination_ru != null ? String(row.destination_ru) : BLANK;
    case 'wave': return row.priority_wave ?? BLANK;
    case 'disposition': return row.disposition ?? BLANK;
    case 'owner': return row.owner ?? BLANK;
    case 'source_verified': return yesNo(row.source_verified);
    case 'source_position': return row.source_position ?? BLANK;
    case 'source_pod': return row.source_pod ?? BLANK;
    case 'destination_verified': return yesNo(row.destination_verified);
    case 'destination_position': return row.destination_position ?? BLANK;
    case 'destination_pod': return row.destination_pod ?? BLANK;
    case 'cable_info': return row.cable_info ?? BLANK;
    case 'vendor_involved': return yesNo(row.vendor_involved);
    case 'asset_status': return row.asset.status_label;
    case 'rfid_tag': return displayRfid(row.asset.rfid_tag);
    case 'location': return row.asset.location_detail ?? BLANK;
    case 'pod_number': return row.asset.pod_number ?? BLANK;
    case 'client': return row.asset.client_name ?? BLANK;
    case 'added': return dayOf(row.created_at);
    case 'updated': return dayOf(row.updated_at);
    default: return '';
  }
}

/** Weighted move progress — each asset vocabulary value carries
 *  an admin-editable progress_weight (0-100, or null = excluded). Per spec
 *  (docs/superpowers/specs/2026-08-25-weighted-progress-design.md):
 *
 *    progress % = round( Σ weight(status(asset)) ÷ (countable × 100) × 100 )
 *
 *  - A null-weight status excludes its rows from BOTH numerator and
 *    denominator (parked/error states must not drag the number).
 *  - A row whose status key has no matching entry in `statuses` (stale
 *    data) counts as weight 0 in the denominator — it IS countable, unlike
 *    a null-weight status.
 *  - Zero countable rows (including zero rows total) -> { pct: 0, countable: 0 },
 *    an early return to avoid dividing by zero. */
export function moveAssetProgress(
  rows: InitiativeAssetRow[],
  statuses: StatusValue[],
): { pct: number; countable: number } {
  const weightByKey = new Map(statuses.map((s) => [s.key, s.progress_weight]));
  let sum = 0;
  let countable = 0;
  for (const row of rows) {
    const weight = weightByKey.has(row.status) ? weightByKey.get(row.status)! : 0;
    if (weight === null) continue;   // null-weight status: excluded entirely
    countable += 1;
    sum += weight;
  }
  if (countable === 0) return { pct: 0, countable: 0 };
  const pct = Math.round((sum / (countable * 100)) * 100);
  return { pct, countable };
}

/** Move-asset status breakdown for the Overview card's donut chart — one
 *  entry per status key with count > 0 among `rows`, ordered by the
 *  vocabulary's sort_order (the `statuses` array's own order, mirroring how
 *  the API already returns it — see `moveAssetProgress` above for the same
 *  key-lookup convention). A row whose status key has no vocab match
 *  (stale data) still counts — it gets its own entry sourced from that
 *  row's own status_label/status_color, appended after every vocab-ordered
 *  entry. `pct` is left unrounded; callers round it for display. */
export function moveAssetStatusBreakdown(
  rows: InitiativeAssetRow[],
  statuses: StatusValue[],
): { key: string; label: string; color: string; count: number; pct: number }[] {
  if (rows.length === 0) return [];
  const vocabByKey = new Map(statuses.map((s) => [s.key, s]));
  const countByKey = new Map<string, number>();
  const staleKeysInOrder: string[] = [];
  for (const row of rows) {
    countByKey.set(row.status, (countByKey.get(row.status) ?? 0) + 1);
    if (!vocabByKey.has(row.status) && !staleKeysInOrder.includes(row.status)) {
      staleKeysInOrder.push(row.status);
    }
  }
  const total = rows.length;
  const entries: { key: string; label: string; color: string; count: number; pct: number }[] = [];
  for (const s of statuses) {
    const count = countByKey.get(s.key) ?? 0;
    if (count === 0) continue;
    entries.push({ key: s.key, label: s.label, color: s.color, count, pct: (count / total) * 100 });
  }
  for (const key of staleKeysInOrder) {
    const staleRow = rows.find((r) => r.status === key)!;
    entries.push({
      key, label: staleRow.status_label, color: staleRow.status_color,
      count: countByKey.get(key)!, pct: (countByKey.get(key)! / total) * 100,
    });
  }
  return entries;
}

export const MOVE_ASSET_ERRORS: Record<string, string> = {
  not_a_move: 'Assets can only be attached to move initiatives.',
  asset_ids_required: 'Pick at least one asset to attach.',
  assets_not_found: 'One or more of those assets no longer exist.',
  assets_already_on_initiative: 'One or more of those assets are already on this move.',
  asset_assignment_not_found: 'That asset assignment no longer exists.',
  invalid_ru: 'RU must be a number.',
  unknown_status: 'Pick a status from the list.',
  forbidden: 'You do not have permission to change this move.',
};

/* ── move assets — inline edit-table mode (Task 5b). Every field here is a
      per-move field on the join row; the asset-identity columns (Asset ID/
      Name/Serial/Make-Model/RFID/Location/Client/Asset Status/Added/
      Updated) have no descriptor and stay read-only under GodCell's normal
      "no gf -> fall through to the plain renderer" convention. */

export interface MoveAssetGodLookups {
  statuses: () => ComboOption[];
}

/** boolean|null -> 'yes'/'no'/'' for the tri-state bool GodField kind
 *  (ASSET_GOD_FIELDS' has_rails inline pattern, pulled out here since three
 *  fields below share it). */
const triFromBool = (v: boolean | null): string => (v == null ? '' : v ? 'yes' : 'no');

export function MOVE_ASSET_EDIT_FIELDS(
  lookups: MoveAssetGodLookups,
): GodField<InitiativeAssetRow>[] {
  return [
    { column: 'wave', field: 'priority_wave', kind: 'text',
      fromRow: (r) => r.priority_wave ?? '' },
    { column: 'disposition', field: 'disposition', kind: 'text',
      fromRow: (r) => r.disposition ?? '' },
    { column: 'owner', field: 'owner', kind: 'text',
      fromRow: (r) => r.owner ?? '' },
    { column: 'source_rack', field: 'source_rack', kind: 'text',
      fromRow: (r) => r.source_rack ?? '' },
    { column: 'source_ru', field: 'source_ru', kind: 'number',
      fromRow: (r) => (r.source_ru != null ? String(r.source_ru) : ''),
      toPatch: numberToPatch },
    { column: 'source_position', field: 'source_position', kind: 'text',
      fromRow: (r) => r.source_position ?? '' },
    { column: 'source_pod', field: 'source_pod', kind: 'text',
      fromRow: (r) => r.source_pod ?? '' },
    { column: 'source_verified', field: 'source_verified', kind: 'bool',
      fromRow: (r) => triFromBool(r.source_verified), toPatch: boolTriToPatch },
    { column: 'destination_rack', field: 'destination_rack', kind: 'text',
      fromRow: (r) => r.destination_rack ?? '' },
    { column: 'destination_ru', field: 'destination_ru', kind: 'number',
      fromRow: (r) => (r.destination_ru != null ? String(r.destination_ru) : ''),
      toPatch: numberToPatch },
    { column: 'destination_position', field: 'destination_position', kind: 'text',
      fromRow: (r) => r.destination_position ?? '' },
    { column: 'destination_pod', field: 'destination_pod', kind: 'text',
      fromRow: (r) => r.destination_pod ?? '' },
    { column: 'destination_verified', field: 'destination_verified', kind: 'bool',
      fromRow: (r) => triFromBool(r.destination_verified), toPatch: boolTriToPatch },
    { column: 'cable_info', field: 'cable_info', kind: 'text',
      fromRow: (r) => r.cable_info ?? '' },
    { column: 'vendor_involved', field: 'vendor_involved', kind: 'bool',
      fromRow: (r) => triFromBool(r.vendor_involved), toPatch: boolTriToPatch },
    { column: 'status', field: 'status', kind: 'select',
      fromRow: (r) => r.status, options: lookups.statuses },
  ];
}

/* ── rack view (Task 6) — placement math for RackViewModal's SVG
      elevation, pulled out as a pure helper per repo convention (pages/
      components stay thin; TDD'd in initiatives.test.ts). ────────────── */

/** A node housed inside another device: a roster row at RU `N.x` whose
 *  parent is the block that starts at RU N. */
export interface RackChild {
  id: string; label: string; slot: number; serial: string | null;
  makeModel: string; verified: boolean; position: string | null;
  categoryLabel: string | null; categoryColor: string | null;
}

/** Front/rear elevation assignment: a side position note that mentions
 *  "rear" (case-insensitively, substring match — "rear-left" counts)
 *  places the row in the REAR elevation; everything else (front,
 *  left/right, blank) lands in FRONT. Lives here beside the placement
 *  math because `rackLayout` parents a node only to a block on its own
 *  side; `RackElevation` re-exports it for its existing importers. */
export function isRearPosition(position: string | null | undefined): boolean {
  return !!position && position.toLowerCase().includes('rear');
}

/** One asset's block in a rack elevation. `ru` is the whole RU the block
 *  starts at; `height` the RUs it occupies. A row at a fractional RU is a
 *  node in slot x of RU N: it becomes a `children` entry of the block that
 *  starts at N on its own side, or, when no such block exists, its own 1U
 *  block at N with an `orphan` reason and its `slot` recorded so the RU
 *  can still be shown as "N.x". Whole-RU blocks have `slot: 0`. `orphan`
 *  names WHY the block is flagged — `'no_chassis'` (nothing starts at this
 *  RU) or `'form_factor'` (the model's form factor contradicts its
 *  position) — and is `null` for an ordinary block, so a plain truthiness
 *  test still reads as "is this flagged?". */
export interface RackBlock {
  id: string; label: string; ru: number; height: number;
  verified: boolean; position: string | null;
  categoryLabel: string | null; categoryColor: string | null;
  makeModel: string;
  slot: number;
  children: RackChild[];
  orphan: 'no_chassis' | 'form_factor' | null;
  /** Node cells only (`nodeBlocks`): the chassis this node sits in. */
  parentRu?: number;
  parentLabel?: string;
  /** Node cells only (`nodeBlocks`): this node's position (ascending slot
   *  order) among its chassis's other nodes, and how many there are —
   *  drawn as `laneCount` vertical slabs side by side across the chassis's
   *  full RU span, this cell in slab `lane`. */
  lane?: number;
  laneCount?: number;
}

/** Splits a stored RU into its whole part and its slot digit: 33.4 is slot
 *  4 of RU 33; 10 is slot 0. Mirrors serversherpa.racks.placement.place(). */
export function ruSlot(ru: number): { base: number; slot: number } {
  const base = Math.floor(ru);
  return { base, slot: Math.round((ru - base) * 10) };
}

/** Filters a move's asset rows down to the ones racked in `rackName` on the
 *  given side, and maps each to its elevation block. A row without an RU
 *  recorded on that side has nothing to place, so it's excluded outright.
 *  `ru_size` defaults to 1 RU. Whole-RU rows become blocks; fractional-RU
 *  rows attach to the block that starts at their RU ON THEIR OWN SIDE
 *  (ascending slot) or stand alone as orphan blocks. The model's form
 *  factor adds two more orphan cases without changing what a row occupies:
 *  a `node` model at a whole RU keeps its height but draws with the orphan
 *  marker, and a `standalone` model at a fractional RU is never adopted as
 *  a child. Blocks come out in row order, orphans after the whole-RU
 *  blocks. */
export function rackLayout(
  rows: InitiativeAssetRow[], rackName: string, side: 'source' | 'destination',
): RackBlock[] {
  const rackOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_rack : r.destination_rack);
  const ruOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_ru : r.destination_ru);
  const verifiedOf = (r: InitiativeAssetRow) =>
    !!(side === 'source' ? r.source_verified : r.destination_verified);
  const positionOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_position : r.destination_position);
  const labelOf = (r: InitiativeAssetRow) =>
    r.asset.name ?? r.asset.serial_number ?? BLANK;
  const makeModelOf = (r: InitiativeAssetRow) =>
    [r.asset.model_make, r.asset.model_name].filter(Boolean).join(' ');

  // RU 0 (or anything below the first usable unit) is "unplaced" — the
  // bottom cap is not a mounting position, so such rows never render.
  const placed = rows
    .filter((r) => rackOf(r) === rackName && (ruOf(r) ?? 0) >= 1)
    .map((r) => ({ r, ...ruSlot(ruOf(r) as number) }));

  const toBlock = (r: InitiativeAssetRow, base: number, slot: number,
                   orphan: RackBlock['orphan']): RackBlock => ({
    id: r.id,
    label: labelOf(r),
    ru: base,
    // A node standing alone occupies its single slot cell; a whole-RU row
    // keeps its model height even when it draws with the orphan marker.
    height: slot === 0 ? (r.asset.ru_size ?? 1) : 1,
    verified: verifiedOf(r),
    position: positionOf(r),
    categoryLabel: r.asset.model_category_label,
    categoryColor: r.asset.model_category_color,
    makeModel: makeModelOf(r),
    slot,
    children: [],
    orphan,
  });

  // A node is housed by a chassis on the SAME physical face of the rack,
  // so the adoption map is keyed on side + base, not base alone.
  const sideKey = (position: string | null, base: number) =>
    `${isRearPosition(position) ? 'R' : 'F'}:${base}`;

  const blocks: RackBlock[] = [];
  const byBase = new Map<string, RackBlock>();
  for (const { r, base, slot } of placed) {
    if (slot !== 0) continue;
    // A `node` model at a whole RU contradicts its position: it keeps its
    // height and can still house nodes, but draws with the orphan marker.
    const b = toBlock(r, base, 0,
      r.asset.model_form_factor === 'node' ? 'form_factor' : null);
    blocks.push(b);
    const key = sideKey(positionOf(r), base);
    if (!byBase.has(key)) byBase.set(key, b);
  }
  // A BLANK position is unstated, not "front": such a node takes the front
  // chassis at its base when there is one, and otherwise the rear one,
  // rather than being orphaned beside a rear chassis it plainly sits in.
  const parentAt = (position: string | null, base: number) => (
    position?.trim()
      ? byBase.get(sideKey(position, base))
      : byBase.get(`F:${base}`) ?? byBase.get(`R:${base}`));
  for (const { r, base, slot } of placed) {
    if (slot === 0) continue;
    // A `standalone` model at a slot contradicts its position too: it is
    // never adopted and stands alone as an orphan at its base.
    const standalone = r.asset.model_form_factor === 'standalone';
    const parent = standalone ? undefined : parentAt(positionOf(r), base);
    if (parent) {
      parent.children.push({
        id: r.id, label: labelOf(r), slot, serial: r.asset.serial_number,
        makeModel: makeModelOf(r), verified: verifiedOf(r),
        position: positionOf(r),
        categoryLabel: r.asset.model_category_label,
        categoryColor: r.asset.model_category_color,
      });
    } else {
      blocks.push(toBlock(r, base, slot,
        standalone ? 'form_factor' : 'no_chassis'));
    }
  }
  for (const b of blocks) b.children.sort((a, c) => a.slot - c.slot);
  return blocks;
}

/** The node elevation's blocks: every child of every block that has
 *  children, as its own cell spanning the PARENT's full RU span (`ru`,
 *  `height` unchanged from the chassis), laid out side by side across the
 *  faceplate's width instead of stacked — `lane` is the cell's position
 *  (ascending slot from the bottom) among its chassis's `laneCount` nodes,
 *  like a row of books rather than rack devices. Nothing else is
 *  included: the caller adds ghosts for the child-less devices so the
 *  frame keeps its RU context. */
export function nodeBlocks(blocks: RackBlock[]): RackBlock[] {
  const out: RackBlock[] = [];
  for (const b of blocks) {
    const n = b.children.length;
    if (n === 0) continue;
    b.children.forEach((c, i) => out.push({
      id: c.id,
      label: c.label,
      ru: b.ru,
      height: b.height,
      verified: c.verified,
      // The cell is drawn on the chassis's face, whatever the node's own
      // position note says; that note surfaces in the hover detail.
      position: b.position,
      categoryLabel: c.categoryLabel ?? b.categoryLabel,
      categoryColor: c.categoryColor ?? b.categoryColor,
      makeModel: c.makeModel,
      slot: c.slot,
      children: [],
      orphan: null,
      parentRu: b.ru,
      parentLabel: b.label,
      lane: i,
      laneCount: n,
    }));
  }
  return out;
}

export interface DeviceListRow {
  id: string; name: string; makeModel: string; ruText: string;
  categoryColor: string | null; group: 'FRONT' | 'REAR';
  indent: boolean; orphan: boolean;
}

/** Rack-order device list rows: each elevation's REAL blocks sorted top
 *  of rack first (descending top RU, ties by name), FRONT group before
 *  REAR. RU text is a dot-range ("40..42") for multi-U devices, "33.1" for
 *  a node. A block's children follow it, indented, in the order the block
 *  carries them (rackLayout sorts them by slot). */
export function deviceListRows(
  front: RackBlock[], rear: RackBlock[],
): DeviceListRow[] {
  const ruTextOf = (b: RackBlock) => {
    if (b.orphan) return `${b.ru}.${b.slot}`;
    return b.height > 1 ? `${b.ru}..${b.ru + b.height - 1}` : String(b.ru);
  };
  const toRows = (blocks: RackBlock[], group: 'FRONT' | 'REAR') =>
    [...blocks]
      .sort((a, b) => (b.ru + b.height) - (a.ru + a.height)
        || a.label.localeCompare(b.label))
      .flatMap((b) => [
        {
          id: b.id, name: b.label,
          makeModel: b.makeModel || '—',
          ruText: ruTextOf(b),
          categoryColor: b.categoryColor, group,
          // the manifest only marks THAT a row is flagged, not why
          indent: false, orphan: !!b.orphan,
        },
        ...b.children.map((c) => ({
          id: c.id, name: c.label,
          makeModel: c.makeModel || '—',
          ruText: `${b.ru}.${c.slot}`,
          categoryColor: c.categoryColor ?? b.categoryColor, group,
          indent: true, orphan: false,
        })),
      ]);
  return [...toRows(front, 'FRONT'), ...toRows(rear, 'REAR')];
}

export interface LegendCategory { label: string; color: string; }

export const UNCATEGORIZED_FILL = '#eef0f3';

/** Distinct categories present among REAL blocks, sorted by label, with a
 *  trailing "Uncategorized" neutral swatch only when some block lacks a
 *  category. */
export function legendCategories(blocks: RackBlock[]): LegendCategory[] {
  const byLabel = new Map<string, string>();
  let uncategorized = false;
  for (const b of blocks) {
    if (b.categoryLabel && b.categoryColor) byLabel.set(b.categoryLabel, b.categoryColor);
    else uncategorized = true;
  }
  const out = [...byLabel].map(([label, color]) => ({ label, color }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (uncategorized) out.push({ label: 'Uncategorized', color: UNCATEGORIZED_FILL });
  return out;
}

/* ── Hierarchy ──────────────────────────────────────────────────────────
 * `initiative_links` makes one initiative the parent of another (a project
 * contains its events). The list and the timeline both render that as
 * nested rows, so the tree is built ONCE here, pure and page-agnostic, and
 * both pages walk the flat result through their existing row markup.
 * `InitiativeItem` satisfies `TreeItem` structurally.                     */

export interface TreeItem {
  id: string;
  /** The API nulls this when the parent is outside the actor's scope, so a
   *  child never points at an id whose existence it would leak. */
  parent_id: string | null;
  /** The link's role ("Event 1"), rendered as a chip after a child's name. */
  parent_role?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
}

/** Compile-time only: a drift in api.ts's `InitiativeItem` (a dropped or
 *  retyped field) must fail HERE, where the tree contract lives, and not
 *  later in whichever page happens to pass the list through the builder.
 *  Exported so `noUnusedLocals` leaves it alone. */
type Extends<A extends B, B> = A;
export type InitiativeItemIsTreeItem = Extends<InitiativeItem, TreeItem>;

export interface InitiativeTreeRow<T extends TreeItem> {
  item: T;
  /** 0 for a root; one per level of nesting below it. */
  depth: number;
  /** True when expanding this row reveals something — i.e. `childCount > 0`. */
  hasChildren: boolean;
  /** Direct children that survive the page's filters, NOT the structural
   *  count: a chevron that expands to nothing would be a lie. Unfiltered
   *  (every id in `matched`) the two are the same number. */
  childCount: number;
  /** False only for a MATCHED node in `collapsed`; its subtree is then not
   *  emitted. A context row is always expanded — collapsing it would hide
   *  the very match it was pulled in to place. */
  expanded: boolean;
  /** An ancestor that does not itself match, kept so a matched descendant
   *  keeps its place. Dimmed, not counted, not selectable. */
  isContext: boolean;
  /** `item.parent_role`, for the chip after a child's name. */
  role: string | null;
}

/**
 * Flatten `items` into render-ordered tree rows.
 *
 * @param items      already filtered to what the page may show at all, and
 *                   already sorted — sibling order is input order, always.
 * @param matched    ids passing the page's own filters/search. A row is
 *                   emitted when it is matched or has a matched descendant
 *                   (the latter flagged `isContext`); anything else is
 *                   dropped entirely.
 * @param collapsed  parent ids whose subtree is hidden.
 *
 * Roots are items with `parent_id === null` **or** whose parent is absent
 * from `items`. An id already placed under one parent is never placed again
 * (first occurrence wins) — new multi-parent links are refused by the API,
 * but a legacy row must not duplicate a node or spin the walk forever.
 */
export function buildInitiativeTree<T extends TreeItem>(
  items: readonly T[],
  matched: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): InitiativeTreeRow<T>[] {
  const present = new Set(items.map((i) => i.id));
  const roots: T[] = [];
  const children = new Map<string, T[]>();
  const placed = new Set<string>();

  for (const item of items) {
    if (placed.has(item.id)) continue;   // defensive: one home per id
    placed.add(item.id);
    const parentId = item.parent_id;
    if (parentId === null || parentId === item.id || !present.has(parentId)) {
      roots.push(item);
    } else {
      const sibs = children.get(parentId);
      if (sibs) sibs.push(item);
      else children.set(parentId, [item]);
    }
  }

  /* Kept-ness is decided bottom-up before anything is emitted, so a matched
   * leaf can still pull its ancestors in. Only nodes reachable from a root
   * are ever visited, and the `placed` set above gives every id exactly one
   * parent, so what is walked here is always a forest: a legacy cycle's
   * members are simply never reached. */
  const keep = new Map<string, boolean>();
  const decide = (node: T): boolean => {
    const cached = keep.get(node.id);
    if (cached !== undefined) return cached;
    /* Defensive and, as the construction above stands, unreachable: the
     * walk is over a forest, so no node is ever re-entered. Kept as a
     * cheap floor under any future change that loosens `placed`. */
    keep.set(node.id, false);            // overwritten below
    let ok = matched.has(node.id);
    for (const kid of children.get(node.id) ?? []) if (decide(kid)) ok = true;
    keep.set(node.id, ok);
    return ok;
  };
  for (const r of roots) decide(r);

  const out: InitiativeTreeRow<T>[] = [];
  const emit = (node: T, depth: number) => {
    if (!keep.get(node.id)) return;
    const kids = (children.get(node.id) ?? []).filter((k) => keep.get(k.id));
    const isContext = !matched.has(node.id);
    /* A context row is force-expanded: it is only here to place a matched
     * descendant, so honoring a stale collapse would swallow the one search
     * result and leave the page reading "0 results" while a match exists.
     * The collapsed set persists across sessions and is shared by both
     * pages, so any user who ever collapsed a project would hit that. This
     * is a no-op while nothing is filtered — then nothing is context. */
    const expanded = !collapsed.has(node.id) || isContext;
    out.push({
      item: node,
      depth,
      hasChildren: kids.length > 0,
      childCount: kids.length,
      expanded,
      isContext,
      role: node.parent_role ?? null,
    });
    if (expanded) for (const kid of kids) emit(kid, depth + 1);
  };
  for (const r of roots) emit(r, 0);
  return out;
}

/**
 * The envelope a dateless parent borrows from its scheduled descendants —
 * the honest answer to "when is this project?" when only its events carry
 * dates. Returns null when `node` has a `scheduled_start` of its own (a real
 * bar always wins; the derived span is never drawn over real dates) and when
 * no descendant is scheduled at all.
 *
 * "Dates of its own" means a `scheduled_start`, exactly as `barFor` in
 * lib/timeline.ts reads it: an end-only node draws no bar there, so
 * suppressing its envelope too would leave its whole scheduled subtree
 * looking unscheduled. Its own end date contributes nothing to the
 * envelope — the span is the descendants' — but it no longer silences it.
 *
 * A descendant with only one of the two dates contributes it as both ends.
 * Comparison goes through `parseApiDay` — the same reading the timeline
 * gives these strings when it draws them — so the earliest/latest pair is
 * the one the user sees, and two spellings of the same day ('…:00Z' and
 * '…:00.000Z') never reorder. A raw `new Date(iso)` would agree only while
 * every value is a midnight-UTC date-only string. The original strings are
 * returned untouched.
 */
export function derivedSpan<T extends TreeItem>(
  node: T, descendants: readonly T[],
): { start: string; end: string } | null {
  if (node.scheduled_start) return null;
  let start: string | null = null;
  let end: string | null = null;
  const at = (iso: string) => parseApiDay(iso).getTime();
  for (const d of descendants) {
    const s = d.scheduled_start ?? d.scheduled_end;
    const e = d.scheduled_end ?? d.scheduled_start;
    if (!s || !e) continue;
    if (start === null || at(s) < at(start)) start = s;
    if (end === null || at(e) > at(end)) end = e;
  }
  return start !== null && end !== null ? { start, end } : null;
}

/** Collapsed parents, shared by the list and the timeline so collapsing a
 *  project in one view collapses it in the other. Expanded is the default:
 *  collapsed-by-default would hide the structure this exists to show. */
export const COLLAPSED_KEY = 'initiatives.collapsed';

/** The `containers.view` try/catch idiom — a private window or blocked
 *  storage yields an empty set rather than throwing on render. */
export function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsed(s: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch { /* ignore — the set is a convenience, never load-bearing */ }
}
