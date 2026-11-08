/** Adapts the kiosk's synced asset and container rows to the portal's
 *  `InitiativeAssetRow` / `ContainerItem`, so the portal's print lists and
 *  label helpers run unchanged on the kiosk. */
import type { ContainerItem, InitiativeAssetRow } from '@portal/lib/api';
import type { TagKey } from '@portal/labels/tagTypes';

import type { KioskAssetRow, KioskContainerRow } from './api';

/** `Number(raw ?? display)`; null when both are absent or not a number. */
export function ruNumber(
  display: string | null | undefined, raw: string | null | undefined,
): number | null {
  const v = raw ?? display;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toPrintAssetRow(a: KioskAssetRow): InitiativeAssetRow {
  return {
    id: a.id,
    asset_id: a.id,
    priority_wave: a.priority_wave ?? null,
    disposition: a.disposition ?? null,
    owner: a.owner ?? null,
    source_pod: a.source_pod ?? null,
    source_rack: a.source_rack ?? null,
    source_ru: ruNumber(a.source_ru, a.source_ru_raw),
    source_verified: null,
    source_position: a.source_position ?? null,
    destination_pod: a.destination_pod ?? null,
    destination_rack: a.destination_rack ?? null,
    destination_ru: ruNumber(a.destination_ru, a.destination_ru_raw),
    destination_verified: null,
    destination_position: a.destination_position ?? null,
    cable_info: null,
    vendor_involved: a.vendor_involved ?? null,
    status: a.roster_status ?? '',
    status_label: a.roster_status_label ?? '',
    status_color: '',
    created_at: '',
    updated_at: '',
    asset: {
      id: a.id,
      legacy_id: a.legacy_id ?? ruNumber(a.asset_id, null),
      serial_number: a.serial_number,
      name: a.name,
      rfid_tag: a.rfid,
      pod_number: a.pod_number ?? null,
      model_make: a.make,
      model_name: a.model,
      ru_size: null,
      model_form_factor: null,
      location_detail: null,
      client_name: null,
      model_category: null,
      model_category_label: null,
      model_category_color: null,
      status: a.asset_status ?? '',
      status_label: a.asset_status_label ?? '',
      status_color: '',
    },
  };
}

export function toPrintContainerItem(c: KioskContainerRow): ContainerItem {
  return {
    id: c.id,
    name: c.name,
    rfid_tag: c.rfid_tag,
    container_type: c.container_type,
    type_label: c.container_type_label ?? null,
    type_color: null,
    status: c.status,
    status_label: c.status_label,
    status_color: '',
    site_id: c.site_id,
    site_name: c.site_name,
    location_detail: '',
    asset_count: c.asset_count,
    last_audit_at: null,
    last_validated_at: null,
    // The sync sends only unarchived containers.
    archived_at: null,
    created_at: '',
    label_tag: (c.label_tag as TagKey | null) ?? null,
  };
}
