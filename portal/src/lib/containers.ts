/**
 * Containers page logic — pure functions the components delegate to
 * (the lib/assets.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { ContainerItem } from './api';
import { displayRfid } from './format';
import type { GodField } from './godEdit';
import { LABEL_TAG_OPTIONS } from './labelTags';
import { naturalCompare } from './sites';

export function containerSearchText(c: ContainerItem): string {
  return [c.name, c.rfid_tag, c.type_label, c.status_label,
          c.site_name, c.location_detail, labelTagText(c)]
    .filter(Boolean).join(' ').toLowerCase();
}

/** The Label tag column/facet/chip's own display label, shared by
 *  `containerCellText` and the page's cell renderer so the two can never
 *  drift ("Label tag" and its facet must show the exact same string). */
export function labelTagText(c: Pick<ContainerItem, 'label_tag'>): string {
  return c.label_tag ? LABEL_TAG_OPTIONS.find((o) => o.key === c.label_tag)?.label ?? '' : '';
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
    case 'label_tag': return labelTagText(c);
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

/* ── nested (by-initiative) list view ─────────────────────────────
 * The flat, filtered + sorted `visible` array can be presented instead
 * as a two-level list: a group header row per initiative (plus one
 * catch-all "No initiative" group, always last) followed by that
 * group's container rows when expanded. `groupContainers` is the pure
 * partition/order/shape step; the page owns which group keys are
 * currently expanded (`expandedKeys`) and re-derives this array
 * whenever that set, or the filtered rows, change. */

/** Group key for containers with no initiative — never a real
 *  initiative id, so it can't collide with one. */
export const NO_INITIATIVE_KEY = '__no_initiative__';

export interface ContainerGroupRow {
  kind: 'group';
  key: string;
  label: string;
  count: number;
  archivedCount: number;
  expanded: boolean;
}

export interface ContainerItemRow {
  kind: 'container';
  item: ContainerItem;
}

export type ContainerListRow = ContainerGroupRow | ContainerItemRow;

/** Partitions `visible` by `initiative_id` into `ContainerListRow`s: one
 *  group-header row per initiative (ordered by initiative name, natural
 *  compare — case/number aware, matching every other list sort in the
 *  app), a final "No initiative" group for containers with none, and —
 *  for a group whose key is in `expandedKeys` — that group's container
 *  rows immediately after its header, in the same (already-sorted)
 *  order as `visible`. A collapsed group still gets its header row (so
 *  Expand all/deep-link can target it), just no container rows. */
export function groupContainers(
  visible: ContainerItem[], expandedKeys: ReadonlySet<string>,
): ContainerListRow[] {
  const order: string[] = [];
  const items = new Map<string, ContainerItem[]>();
  const labels = new Map<string, string>();
  for (const c of visible) {
    const key = c.initiative_id ?? NO_INITIATIVE_KEY;
    if (!items.has(key)) {
      order.push(key);
      items.set(key, []);
      labels.set(key, key === NO_INITIATIVE_KEY ? 'No initiative' : (c.initiative_name ?? ''));
    }
    items.get(key)!.push(c);
  }

  order.sort((a, b) => {
    if (a === NO_INITIATIVE_KEY) return 1;
    if (b === NO_INITIATIVE_KEY) return -1;
    return naturalCompare(labels.get(a)!, labels.get(b)!);
  });

  const rows: ContainerListRow[] = [];
  for (const key of order) {
    const groupItems = items.get(key)!;
    const expanded = expandedKeys.has(key);
    rows.push({
      kind: 'group',
      key,
      label: labels.get(key)!,
      count: groupItems.length,
      archivedCount: groupItems.filter((c) => c.archived_at).length,
      expanded,
    });
    if (expanded) {
      for (const item of groupItems) rows.push({ kind: 'container', item });
    }
  }
  return rows;
}

/** Every group key `groupContainers` would produce for `visible` —
 *  independent of which are currently expanded. Used for Expand all
 *  (expand every key) and to validate a deep-link target's group. */
export function containerGroupKeys(visible: ContainerItem[]): string[] {
  return groupContainers(visible, new Set())
    .filter((r): r is ContainerGroupRow => r.kind === 'group')
    .map((r) => r.key);
}

/** The group key a given container falls into — the same rule
 *  `groupContainers` uses, exposed so the page can auto-expand a
 *  deep-linked container's group without re-deriving it. */
export function containerGroupKey(c: Pick<ContainerItem, 'initiative_id'>): string {
  return c.initiative_id ?? NO_INITIATIVE_KEY;
}
