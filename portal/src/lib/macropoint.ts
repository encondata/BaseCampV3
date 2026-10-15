/** MacroPoint manual update: pure helpers for the Manual update modal
 *  (reason copy, truck picker options, assignments, .eml file list). */
import type { ComboOption } from '../components/ComboBox';
import type { MacroPointGroup, MacroPointPreview, MacroPointTruckOption } from './api';

const REASONS: Record<string, string> = {
  not_macropoint: 'Not a MacroPoint email',
  unreadable: 'Could not read this file',
  unknown_zone: 'Unknown time zone',
  bad_time: 'Date/Time is not a real date',
  bad_location: 'Location is out of range',
  no_truck: 'No truck picked',
  truck_not_active: 'Truck is no longer active',
};
const FIELDS: Record<string, string> = {
  id_number: 'ID Number', date_time: 'Date/Time', location: 'Location', event: 'Event',
};

export function reasonText(reason: string): string {
  if (reason.startsWith('missing_field:')) {
    const f = reason.slice('missing_field:'.length);
    return `Missing ${FIELDS[f] ?? f}`;
  }
  return REASONS[reason] ?? reason;
}

export function noteText(note: string | null): string {
  if (note === 'linked_to_other_order') {
    return 'Truck is linked to a different MacroPoint order; link not changed';
  }
  return note ?? '';
}

/** HTTP error codes from the preview/apply routes. */
export const MACROPOINT_ERRORS: Record<string, string> = {
  nothing_to_parse: 'Add .eml files or paste email text first.',
  too_many_files: 'Too many files — 500 at most per upload.',
  file_too_large: 'A file is larger than 2 MB.',
  upload_too_large: 'The upload is larger than 20 MB.',
  text_too_large: 'The pasted text is larger than 1 MB.',
  bad_assignments: 'Could not read the truck picks — try again.',
};

export function initialAssignments(preview: MacroPointPreview): Record<string, string> {
  return Object.fromEntries(preview.groups.map((g) => [g.group_key, g.match.truck_id ?? '']));
}

export function assignmentsPayload(
  groups: MacroPointGroup[], chosen: Record<string, string>,
): Record<string, string | null> {
  return Object.fromEntries(groups.map((g) => [g.group_key, chosen[g.group_key] || null]));
}

/** Picker options in the API's (natural) order, with `first` ids (an
 *  ambiguous match's candidates) moved to the top. */
export function truckOptions(trucks: MacroPointTruckOption[], first: string[] = []): ComboOption[] {
  const lead = trucks.filter((t) => first.includes(t.id));
  const rest = trucks.filter((t) => !first.includes(t.id));
  return [...lead, ...rest].map((t) => ({
    value: t.id,
    label: t.name,
    sub: t.initiative_name ? `${t.status_label} · ${t.initiative_name}` : t.status_label,
  }));
}

export function isEml(file: File): boolean {
  return file.name.toLowerCase().endsWith('.eml');
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

export function mergeFiles(current: File[], added: File[]): File[] {
  const seen = new Set(current.map(fileKey));
  const out = [...current];
  for (const f of added) {
    if (!seen.has(fileKey(f))) { seen.add(fileKey(f)); out.push(f); }
  }
  return out;
}
