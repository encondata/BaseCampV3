/** Pure helpers for the System Config ENV tab. */

import type { EnvEntry } from './api';

export function filterEntries(
  entries: EnvEntry[], q: string,
): EnvEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.key.toLowerCase().includes(needle));
}

export function changedValues(
  entries: EnvEntry[], edits: Record<string, string>,
): Record<string, string> {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(edits)) {
    const entry = byKey.get(key);
    if (!entry) continue;
    if (entry.secret) {
      if (value !== '') out[key] = value;
    } else if (value !== (entry.value ?? '')) {
      out[key] = value;
    }
  }
  return out;
}

export function describeEntry(
  e: EnvEntry,
): { placeholder: string; chip: string | null } {
  if (!e.secret) return { placeholder: '', chip: null };
  return e.set
    ? { placeholder: '••••••••  (leave blank to keep)', chip: 'set' }
    : { placeholder: 'enter a value', chip: 'not set' };
}
