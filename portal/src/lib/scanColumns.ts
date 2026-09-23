/**
 * Column registries for the two Scans tabs. They live here, not in the tab
 * components, so their fit tests can import them as plain node tests — the
 * components drag VirtualRows, the column-menu machinery, and AuthContext in
 * with them (recipe R7). Same convention as lib/sites.ts's SITE_COLUMNS and
 * lib/auditFormat.ts's AUDIT_COLUMNS.
 */
import type { ColumnDef } from './listTools';

/* ── Processed scans ─────────────────────────────────────────────── */

// The always-shown scanned-value cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead (recipe R1).
export const PROCESSED_SCAN_PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Value', width: '2fr', default: true, min: 160,
};

// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page
// at a 1512px window, nav expanded; Scans.tsx mounts this tab directly
// under .portal-page, no wrapping card).
export const PROCESSED_SCAN_COLUMNS: ColumnDef[] = [
  { key: 'match', label: 'Match', width: '1fr', default: true },
  { key: 'status', label: 'Scan status', width: '1.1fr', default: true },
  { key: 'matched', label: 'Matched record', short: 'Matched', width: '1.3fr', default: true },
  { key: 'scanned', label: 'Scanned', width: '1.1fr', default: true, min: 96 },
  { key: 'processed', label: 'Processed', width: '1.1fr', default: false },
  { key: 'scan_type', label: 'Method', width: '0.9fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: true, min: 100 },
  { key: 'operator', label: 'Operator', width: '1fr', default: false },
  { key: 'site', label: 'Site', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
];

/* ── Raw scans ───────────────────────────────────────────────────── */

// The always-shown scanned-value cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead (recipe R1).
export const RAW_SCAN_PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Value', width: '2fr', default: true, min: 160,
};

// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page
// at a 1512px window, nav expanded; Scans.tsx mounts this tab directly
// under .portal-page, no wrapping card).
export const RAW_SCAN_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Scan status', width: '1.1fr', default: true },
  { key: 'scan_type', label: 'Method', width: '0.9fr', default: true },
  { key: 'scanned', label: 'Scanned', width: '1.1fr', default: true, min: 96 },
  { key: 'device', label: 'Device', width: '1fr', default: true, min: 100 },
  { key: 'operator', label: 'Operator', width: '1fr', default: true },
  { key: 'site', label: 'Site', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
  { key: 'ingested', label: 'Ingested', width: '1.1fr', default: false },
];
