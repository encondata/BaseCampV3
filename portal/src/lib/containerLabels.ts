/**
 * Container Labels page logic — pure functions the page and
 * `ContainerPickList`/`ContainerLabelsOptions` delegate to, unit-testable
 * without jsdom (the `lib/assets.ts` / `lib/containers.ts` pattern).
 *
 * Selection and tags are kept as plain arrays/records (not `Set`/`Map`) so
 * they slot straight into React state and are trivially comparable in
 * tests. Tags never store `'none'` (a valid `TagKey` member per
 * `containerLabelSheet.ts`, kept only so the drawing routine's own
 * `container.tag || null` check has a harmless truthy default to fall
 * back to) — "no tag" is always the ABSENCE of a key, mirroring V2's own
 * `containerTags` state which `delete`s the entry instead of writing
 * `'none'`.
 */
import type { ContainerItem, InitiativeItem } from './api';
import type { ContainerLabelInput, TagKey } from '../labels/containerLabelSheet';

/** The five real tags, in V2's own display order, for both
 *  `ContainerTagPicker`'s menu and `ContainerPickList`'s bulk `.segmented`
 *  row — one export so the two never drift apart. `TAG_TYPES`
 *  (`containerLabelSheet.ts`) also carries `'none'`, a harmless default
 *  the drawing routine falls back to; it is never offered as its own
 *  choice here (see this file's header comment). */
export const TAG_CHOICES: TagKey[] = ['priority', 'vendor', 'accessories', 'ewaste', 'warehouse'];

/** V2's own move/container name fallbacks, reused for the on-page summary
 *  and the PDF input alike. */
export function containerDisplayName(c: Pick<ContainerItem, 'id' | 'name'>): string {
  return c.name || `Container ${c.id}`;
}

export function initiativeDisplayName(i: Pick<InitiativeItem, 'id' | 'name'>): string {
  return i.name || `Move #${i.id}`;
}

/** Search filter over name/type, case-insensitive — V2's `filteredContainers`. */
export function filterContainers(list: ContainerItem[], term: string): ContainerItem[] {
  const q = term.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) =>
    c.name.toLowerCase().includes(q) || (c.type_label ?? '').toLowerCase().includes(q));
}

/** Toggle one id in a selection array — adds if absent, removes if present. */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id];
}

/** Header checkbox action, matching V2's own `handleSelectAll` exactly:
 *  checking REPLACES the whole selection with the current filtered ids;
 *  unchecking clears the selection to `[]` entirely — a selection made
 *  outside the current search term does not survive either action, same
 *  as V2's `setSelectedContainers(checked ? filteredContainers.map(...) : [])`.
 *  (The header checkbox's own checked/indeterminate state stays
 *  intersection-based — `selected ∩ filteredIds` — computed separately in
 *  `ContainerPickList`; only this ACTION mirrors V2's replace/clear.) */
export function selectAllFiltered(filteredIds: string[], checked: boolean): string[] {
  return checked ? [...filteredIds] : [];
}

/** The containers actually labeled by Download/Generate-as-report: V2's
 *  own `containersToLabel = filteredContainers.filter(selectedSet.has)` —
 *  selected ids that are ALSO in the current filtered view, in `list`'s
 *  display order. A selection made before narrowing the search (and thus
 *  hidden by it) is excluded, exactly like V2, even though it stays
 *  selected in the UI (so clearing the search brings it right back). */
export function labeledContainers(
  list: ContainerItem[], selected: string[], filteredIds: string[],
): ContainerItem[] {
  const selectedSet = new Set(selected);
  const filteredSet = new Set(filteredIds);
  return list.filter((c) => selectedSet.has(c.id) && filteredSet.has(c.id));
}

/** Bulk "Set tag" action for a set of ids: `key: null` clears the tag
 *  (deletes the entry) for every id, matching V2's `handleBulkTag`. */
export function applyBulkTag(
  tags: Record<string, TagKey>, ids: string[], key: TagKey | null,
): Record<string, TagKey> {
  const next = { ...tags };
  for (const id of ids) {
    if (key) next[id] = key;
    else delete next[id];
  }
  return next;
}

/** The report run's `options` payload — `container_ids` in selection
 *  order, `tags` narrowed to only the selected ids that actually carry
 *  one (an id that was tagged and then deselected doesn't leak its tag
 *  into the run). */
export function buildRunOptions(
  selectedIds: string[], tags: Record<string, TagKey>,
): { container_ids: string[]; tags: Record<string, TagKey> } {
  const out: Record<string, TagKey> = {};
  for (const id of selectedIds) {
    if (tags[id]) out[id] = tags[id];
  }
  return { container_ids: [...selectedIds], tags: out };
}

/** Every distinct tag actually assigned to a selected container — drives
 *  the Step 3 summary chips and which tag images `loadTagImages` needs. */
export function tagsInUse(selectedIds: string[], tags: Record<string, TagKey>): TagKey[] {
  const seen = new Set<TagKey>();
  for (const id of selectedIds) {
    const tag = tags[id];
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** Seeds the page/options-step `tags` state from each container's own
 *  stored `label_tag` (the addendum: "the tag chosen per container ...
 *  should be read from the container"). A container with no `label_tag`
 *  gets no entry — same "absence, not `'none'`" convention as the rest of
 *  this file. */
export function tagsFromContainers(
  containers: Pick<ContainerItem, 'id' | 'label_tag'>[],
): Record<string, TagKey> {
  const out: Record<string, TagKey> = {};
  for (const c of containers) {
    if (c.label_tag) out[c.id] = c.label_tag;
  }
  return out;
}

/** Every container id whose tag actually differs between two `tags` maps
 *  (absence and `undefined` both read as "no tag", so clearing a tag and
 *  never having had one compare equal) — drives which containers get a
 *  PATCH when the picker's `tags` state changes, whether from a single
 *  row's picker or a bulk "Set tag" action over many rows at once. */
export function changedTagIds(
  prev: Record<string, TagKey>, next: Record<string, TagKey>,
): string[] {
  const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...ids].filter((id) => (prev[id] ?? null) !== (next[id] ?? null));
}

/** Persists a `tags` state change: PATCHes every changed container (per
 *  `changedTagIds`) in parallel via the injected `updateFn` (dependency
 *  injected — rather than importing `updateContainer` here — so this
 *  stays a plain, jsdom-free unit under test, like the rest of this
 *  file), and rolls back `next` to `prev`'s value for any container whose
 *  PATCH rejected. The caller (`ContainerLabels.tsx` /
 *  `ContainerLabelsOptions.tsx`) applies `next` optimistically before
 *  calling this, then replaces it with the returned `tags`, and refreshes
 *  its container list afterward so `label_tag` stays server-current. */
export async function persistTagChanges(
  prev: Record<string, TagKey>,
  next: Record<string, TagKey>,
  updateFn: (id: string, tag: TagKey | null) => Promise<unknown>,
): Promise<{ tags: Record<string, TagKey>; failed: boolean }> {
  const changed = changedTagIds(prev, next);
  if (changed.length === 0) return { tags: next, failed: false };

  const results = await Promise.allSettled(
    changed.map((id) => updateFn(id, next[id] ?? null)),
  );

  const out = { ...next };
  let failed = false;
  results.forEach((result, i) => {
    if (result.status !== 'rejected') return;
    failed = true;
    const id = changed[i];
    if (prev[id]) out[id] = prev[id];
    else delete out[id];
  });
  return { tags: out, failed };
}

/** Builds `buildContainerLabelPdf`'s input from the picked initiative and
 *  the containers to label, in the order given (the caller already
 *  narrowed `containers` to the selected ids in display order).
 *  `tagImages` starts empty — the caller (which alone knows which tags are
 *  in use and can await `loadTagImages`) spreads the loaded map over this
 *  result: `{ ...toPdfInput(...), tagImages }`. */
export function toPdfInput(
  initiative: InitiativeItem, containers: ContainerItem[], tags: Record<string, TagKey>,
): ContainerLabelInput {
  return {
    move: {
      id: initiative.id,
      name: initiativeDisplayName(initiative),
      sourceSite: initiative.origin_site_name ?? 'N/A',
      destSite: initiative.destination_site_name ?? 'N/A',
      scheduledStart: initiative.scheduled_start ?? null,
    },
    containers: containers.map((c) => ({
      id: c.id,
      name: containerDisplayName(c),
      tag: tags[c.id] ?? null,
    })),
    tagImages: {},
  };
}
