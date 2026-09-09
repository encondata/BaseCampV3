/**
 * Scans page logic — pure functions the components delegate to
 * (the lib/containers.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { ProcessedScanRow, RawScanRow } from './api';
import type { GodField } from './godEdit';
import { displayScanValue } from './format';

export function processedScanSearchText(s: ProcessedScanRow): string {
  return [s.scanned_value, s.matched_name, s.match_type_label,
          s.scan_type_label, s.status_label, s.device_id, s.operator_name,
          s.site_name, s.location_detail, s.source]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown scanned-value cell; 'archived' is the pseudo-column. */
export function processedScanCellText(s: ProcessedScanRow, colKey: string): string {
  switch (colKey) {
    case 'primary': return displayScanValue(s.scanned_value, s.scan_type);
    case 'match': return s.match_type_label;
    case 'matched': return s.matched_name ?? '—';
    case 'scan_type': return s.scan_type_label;
    case 'scanned': return new Date(s.scanned_at).toLocaleString();
    case 'processed': return new Date(s.processed_at).toLocaleString();
    case 'device': return s.device_id || '—';
    case 'operator': return s.operator_name ?? '—';
    case 'site': return s.site_name ?? '—';
    case 'location': return s.location_detail || '—';
    case 'source': return s.source || '—';
    case 'archived': return s.archived_at ? 'Yes' : 'No';
    case 'status': return s.status_label ?? '—';
    default: return '';
  }
}

/** Deep link to the matched record's own list page, or null when the
 *  target id is missing (e.g. hard-deleted later). */
export function matchedHref(s: ProcessedScanRow): string | null {
  if (s.match_type === 'asset' && s.asset_id) {
    return `/assets?open=${encodeURIComponent(s.asset_id)}`;
  }
  if (s.match_type === 'container' && s.container_id) {
    return `/logistics/containers?open=${encodeURIComponent(s.container_id)}`;
  }
  if (s.match_type === 'person' && s.person_id) {
    return `/people/users?open=${encodeURIComponent(s.person_id)}`;
  }
  return null;
}

export function rawScanSearchText(r: RawScanRow): string {
  return [r.scanned_value, r.scan_type_label, r.status_label, r.device_id,
          r.operator_name, r.site_name, r.location_detail, r.source]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor for the raw list — mirrors RawScansTab's cell
 *  renderer exactly (including '—' fallbacks). No 'archived' pseudo-column:
 *  raw scans have no archived_at. */
export function rawScanCellText(r: RawScanRow, colKey: string): string {
  switch (colKey) {
    case 'primary': return displayScanValue(r.scanned_value, r.scan_type);
    case 'scan_type': return r.scan_type_label;
    case 'scanned': return new Date(r.scanned_at).toLocaleString();
    case 'device': return r.device_id || '—';
    case 'operator': return r.operator_name ?? '—';
    case 'site': return r.site_name ?? '—';
    case 'location': return r.location_detail || '—';
    case 'source': return r.source || '—';
    case 'ingested': return new Date(r.created_at).toLocaleString();
    case 'status': return r.status_label ?? '—';
    default: return '';
  }
}

export const SCANS_ERRORS: Record<string, string> = {
  processed_scan_not_found: 'That scan no longer exists.',
  site_not_found: 'Pick a site from the list.',
  operator_not_found: 'Pick a person from the list.',
  location_detail_required: 'Location cannot be null.',
  forbidden: 'You do not have permission to change scans.',
};

/* ── god-edit descriptors (lib/containers.ts factory pattern) ─────── */

export interface ProcessedScanGodLookups {
  sites: () => ComboOption[];
  people: () => ComboOption[];
}

/** Exactly the PATCH surface: site, location, operator. Match fields
 *  are never editable — re-matching is the (future) processor's job. */
export function PROCESSED_SCAN_GOD_FIELDS(
  lookups: ProcessedScanGodLookups,
): GodField<ProcessedScanRow>[] {
  return [
    { column: 'location', field: 'location_detail', kind: 'text',
      fromRow: (s) => s.location_detail },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (s) => s.site_id ?? '', options: lookups.sites },
    { column: 'operator', field: 'operator_id', kind: 'combo',
      fromRow: (s) => s.operator_id ?? '', options: lookups.people },
  ];
}
