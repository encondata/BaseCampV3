/**
 * Column registries for the two site-survey lists. They live here, not in the
 * list components, so their fit tests can import them as plain node tests —
 * the components drag VirtualRows, the god-edit cells, and AuthContext in with
 * them (recipe R7). Same convention as lib/sites.ts's SITE_COLUMNS.
 */
import type { ColumnDef } from './listTools';

/* ── Curated survey (GET /sites/{id}/survey) ─────────────────────── */

// The always-shown field cell — a fixed leading track outside the column
// registry (same shape as the header markup below), so it needs its own
// ColumnDef for listGridStyle/ColHead (recipe R1).
export const SITE_SURVEY_PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Field', width: '2fr', default: true, min: 160,
};

// Fit: default columns + trailing ≤ LIST_FIT.initPanel (1134px — this list
// sits inside an .init-panel, initiatives.css: padding 16px 18px plus a
// 1px border, 19px each side, nested in a CollapsePanel that adds no
// horizontal padding of its own).
export const SITE_SURVEY_COLUMNS: ColumnDef[] = [
  { key: 'group', label: 'Group', width: '1fr', default: true },
  { key: 'value', label: 'Value', width: '1.4fr', default: true },
  { key: 'updated_by', label: 'Updated by', width: '1fr', default: true },
  { key: 'updated', label: 'Updated', width: '1fr', default: false, min: 96 },
];

/* ── Raw submission trail (GET /sites/{id}/survey/raw) ───────────── */

// The always-shown field-key cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead (recipe R1).
export const RAW_SURVEY_PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Field', width: '2fr', default: true, min: 150,
};

// Fit: default columns + trailing ≤ LIST_FIT.initPanel (1134px — this list
// sits inside an .init-panel, initiatives.css: padding 16px 18px plus a
// 1px border, 19px each side, nested in a CollapsePanel that adds no
// horizontal padding of its own).
export const RAW_SURVEY_COLUMNS: ColumnDef[] = [
  { key: 'value', label: 'Value', width: '1.4fr', default: true },
  { key: 'registered', label: 'Registered', width: '0.8fr', default: true },
  { key: 'source', label: 'Source', width: '0.8fr', default: true },
  { key: 'submitted_by', label: 'Submitted by', width: '1fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: false },
  { key: 'captured', label: 'Captured', width: '1.1fr', default: true, min: 96 },
  { key: 'ingested', label: 'Ingested', width: '1fr', default: false },
];
