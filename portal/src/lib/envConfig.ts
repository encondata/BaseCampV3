/** Pure helpers for the System Config ENV tab. */

import type { EnvEntry, EnvMissingEntry } from './api';

export function filterEntries(
  entries: EnvEntry[], q: string,
): EnvEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.key.toLowerCase().includes(needle)
    || e.description.toLowerCase().includes(needle));
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

export function changedDescriptions(
  entries: EnvEntry[], descEdits: Record<string, string>,
): Record<string, string> {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const out: Record<string, string> = {};
  for (const [key, description] of Object.entries(descEdits)) {
    const entry = byKey.get(key);
    if (!entry) continue;
    if (description !== entry.description) out[key] = description;
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

export function filterMissing(
  missing: EnvMissingEntry[], q: string,
): EnvMissingEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return missing;
  return missing.filter((e) => e.key.toLowerCase().includes(needle)
    || e.description.toLowerCase().includes(needle));
}

/** Edits to settings that aren't in .env yet. Only a non-empty value counts
 *  — a field that was typed in and cleared is unchanged, and an empty
 *  secret is skipped like the server does. */
export function changedMissing(
  missing: EnvMissingEntry[], edits: Record<string, string>,
): Record<string, string> {
  const byKey = new Map(missing.map((e) => [e.key, e]));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(edits)) {
    const entry = byKey.get(key);
    if (!entry) continue;
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

export function describeMissing(
  e: EnvMissingEntry,
): { placeholder: string; chip: string } {
  return { placeholder: e.secret ? 'secret' : (e.example ?? ''), chip: 'Not in .env' };
}
