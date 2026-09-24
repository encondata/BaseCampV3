/**
 * Bulk new containers — pure helpers for `BulkContainersModal`, split out
 * so the naming/tag-assignment math is unit-testable without jsdom (the
 * lib/assets.ts / lib/containers.ts pattern). Mirrors the API's own
 * `POST /containers/bulk` behavior exactly (see
 * docs/superpowers/specs/2026-09-12-bulk-new-containers-design.md) so the
 * modal's live preview and summary never drift from what the server will
 * actually do.
 */
import { TAG_TYPES, type TagKey } from '../labels/tagTypes';

export interface NamingConfig {
  prefix: string;
  start: number;
  pad: number;      // 0 = no padding, else zero-pad to this many digits
  suffix: string;
}

/** `label_tag` keys the bulk endpoint accepts — `TagKey` minus `'none'`,
 *  which (per `LABEL_TAG_OPTIONS`'s own convention) is never a value here:
 *  "no tag" is represented by the key's absence/zero, not a `'none'`
 *  count. */
export type TagCounts = Partial<Record<Exclude<TagKey, 'none'>, number>>;

/** Jimmy: "We assign tags in order of Priority, Vendor, Accessories,
 *  Warehouse and E-Waste." Fixed regardless of `LABEL_TAG_OPTIONS`'s own
 *  order (which lists ewaste before warehouse, for its unrelated
 *  drawing-routine heritage). */
export const TAG_ASSIGNMENT_ORDER: Exclude<TagKey, 'none'>[] =
  ['priority', 'vendor', 'accessories', 'warehouse', 'ewaste'];

/** `name = prefix + zero-padded(start + i) + suffix` for i in [0, count) —
 *  the exact rule the API applies when it generates rows in creation
 *  order. */
export function buildNames(naming: NamingConfig, count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = naming.start + i;
    const digits = naming.pad > 0 ? String(n).padStart(naming.pad, '0') : String(n);
    names.push(`${naming.prefix}${digits}${naming.suffix}`);
  }
  return names;
}

/** The live "Preview" line: first three names, then an ellipsis and the
 *  last one — full list (no ellipsis) when there are four or fewer, so
 *  the ellipsis never stands in for just a single hidden name. */
export function previewNames(naming: NamingConfig, count: number): string {
  if (count <= 0) return '';
  const names = buildNames(naming, count);
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} … ${names[names.length - 1]}`;
}

/** Sum of every tag's count (missing/undefined counts as 0). */
export function tagTotal(tags: TagCounts): number {
  return TAG_ASSIGNMENT_ORDER.reduce((sum, key) => sum + (tags[key] ?? 0), 0);
}

/** The tag (or `null` for "no tag") assigned to each of the `count`
 *  containers, in creation order: the first `tags.priority` get
 *  `'priority'`, the next `tags.vendor` get `'vendor'`, and so on down
 *  `TAG_ASSIGNMENT_ORDER`; everything after the assigned tags is `null`.
 *  Mirrors the API's own assignment rule exactly. */
export function assignTags(count: number, tags: TagCounts): (TagKey | null)[] {
  const result: (TagKey | null)[] = new Array(Math.max(0, count)).fill(null);
  let idx = 0;
  for (const key of TAG_ASSIGNMENT_ORDER) {
    const n = Math.max(0, tags[key] ?? 0);
    for (let i = 0; i < n && idx < result.length; i++, idx++) {
      result[idx] = key;
    }
  }
  return result;
}

/** When `count` drops below the tag total, clamp it back down by trimming
 *  from the LAST tag in `TAG_ASSIGNMENT_ORDER` backwards (E-Waste first,
 *  then Warehouse, …) until the total fits — same order the assignment
 *  rule fills tags in, just run in reverse. Returns the clamped tags plus
 *  whatever was trimmed off each key (only keys that lost something are
 *  present), so the caller can say what happened. A no-op (empty
 *  `trimmed`, `tags` returned as-is) when the total already fits. */
export function clampTags(
  tags: TagCounts, count: number,
): { tags: TagCounts; trimmed: TagCounts } {
  let excess = tagTotal(tags) - count;
  if (excess <= 0) return { tags, trimmed: {} };
  const next: TagCounts = { ...tags };
  const trimmed: TagCounts = {};
  for (let i = TAG_ASSIGNMENT_ORDER.length - 1; i >= 0 && excess > 0; i--) {
    const key = TAG_ASSIGNMENT_ORDER[i]!;
    const current = next[key] ?? 0;
    if (current <= 0) continue;
    const cut = Math.min(current, excess);
    next[key] = current - cut;
    trimmed[key] = cut;
    excess -= cut;
  }
  return { tags: next, trimmed };
}

/** "15 containers · 1 Priority · 2 Vendor · 12 untagged" — one segment per
 *  non-zero tag (in assignment order), then the untagged remainder if
 *  any. `noun` names the things counted ("crate" for Create a move in
 *  steps). */
export function summaryText(count: number, tags: TagCounts, noun = 'container'): string {
  const parts = [`${count} ${noun}${count === 1 ? '' : 's'}`];
  for (const key of TAG_ASSIGNMENT_ORDER) {
    const n = tags[key] ?? 0;
    if (n > 0) parts.push(`${n} ${TAG_TYPES[key].label}`);
  }
  const untagged = count - tagTotal(tags);
  if (untagged > 0) parts.push(`${untagged} untagged`);
  return parts.join(' · ');
}

/** Zero-pad width is derived from the batch, never chosen: enough digits
 *  for the LAST number plus one leading zero, capped at 4. 1..9 → 2,
 *  10..99 → 3, 100..999 → 4, 1000+ → 4 (the leading zero drops away). */
export const MAX_PAD = 4;
export const MAX_NUMBER = 9999;

export function autoPad(start: number, count: number): number {
  const last = Math.max(0, start) + Math.max(1, count) - 1;
  return Math.min(MAX_PAD, String(last).length + 1);
}

/** True when the batch would run past four digits (no name may exceed 9999). */
export function numberOverflow(start: number, count: number): boolean {
  return Math.max(0, start) + Math.max(1, count) - 1 > MAX_NUMBER;
}
