/** Reports helpers shared by the page and the Generate modal. */
import type { InitiativeItem } from './api';
import { parseApiDay } from './timeline';

export interface ReportSection { key: string; title: string; description: string }

export const MOVE_REPORT_SECTIONS: ReportSection[] = [
  { key: 'summary', title: 'Summary', description: 'Move info, locations, load summary, collision summary' },
  { key: 'assets_by_source', title: 'Asset List - By Source', description: 'Assets sorted by source rack and RU' },
  { key: 'assets_by_destination', title: 'Asset List - By Destination', description: 'Assets sorted by destination rack and RU' },
  { key: 'size_weight', title: 'Size and Weight Report', description: 'Total RU, weight, per-model breakdown' },
  { key: 'rail_usage', title: 'Rail Usage Report', description: 'Rail types summary and model breakdown' },
  { key: 'collisions', title: 'Collision Report', description: 'Overlapping RU assignment details' },
  { key: 'source_racks', title: 'Source Rack Elevations', description: 'Visual rack diagrams for source racks' },
  { key: 'destination_racks', title: 'Destination Rack Elevations', description: 'Visual rack diagrams for destination racks' },
];

export function sectionCount(options: Record<string, unknown>): number {
  return MOVE_REPORT_SECTIONS.filter((s) => options[s.key]).length;
}

/** Seeded `status_values` keys for record_type=initiative that get their
 *  own group in the picker, most-likely-to-be-reported-on first. Every
 *  other status — `completed`, `cancelled`, and any unseeded key — shares
 *  the single trailing group, so finished work reads as one alphabetical
 *  tail rather than several one-row bands. */
export const STATUS_GROUP_ORDER = ['in_progress', 'scheduled', 'planned', 'on_hold'];

export function sortInitiativesForPicker(items: InitiativeItem[]): InitiativeItem[] {
  const rank = (s: string) => {
    const i = STATUS_GROUP_ORDER.indexOf(s);
    return i === -1 ? STATUS_GROUP_ORDER.length : i;
  };
  return items
    .filter((i) => !i.archived_at)
    .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
}

/**
 * Open a presigned download in a new tab. The tab has to be claimed
 * SYNCHRONOUSLY inside the click's own task — by the time the presign
 * round-trip resolves the browser no longer counts the open as
 * user-initiated and blocks it — so claim a blank tab first and point it
 * at the URL once it arrives. Rejects with the fetch's own error (the
 * blank tab is closed first) so callers keep showing their own message.
 */
export async function openPresigned(fetchUrl: () => Promise<string>): Promise<void> {
  const win = window.open('', '_blank');
  let url: string;
  try {
    url = await fetchUrl();
  } catch (err) {
    win?.close();
    throw err;
  }
  if (win) win.location.href = url;
  else window.open(url, '_blank');       // popup blocked: one more try, no worse
}

export function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared by GenerateReportModal's pick step (scheduled dates) and
 *  ReportOptionsLayout's preview card (scheduled start/end) — both are the
 *  date-only scheduled_start/scheduled_end fields, stored as midnight UTC
 *  for a plain YYYY-MM-DD input. Parse the Y-M-D digits into a local Date
 *  first: `new Date(s)` would land on the previous evening west of UTC and
 *  name the day before. The bare `toLocaleDateString()` call is kept as-is
 *  so the rendered format doesn't change. */
export const fmtDate = (s: string | null): string => (s ? parseApiDay(s).toLocaleDateString() : '—');
