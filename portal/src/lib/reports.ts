/** Reports helpers shared by the page and the Generate modal. */
import type { InitiativeItem } from './api';

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

export function sectionCount(options: Record<string, boolean>): number {
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

export function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
