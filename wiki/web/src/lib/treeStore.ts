/** A tiny module-level cache of tree children, one entry per (space,
 *  parent), shared by the sidebar tree, folder views and space homes so a
 *  create/move/rename/delete anywhere refreshes them all. Read it with
 *  `useChildren` / `useTreeRevision` (useSyncExternalStore); write it with
 *  the `note*` functions after a successful mutation. */
import { useEffect, useSyncExternalStore } from 'react';

import type { NodeOut } from './types';
import { getTree } from './wikiApi';

export interface ChildrenEntry {
  /** null until the first response lands; stale nodes stay while a refetch runs. */
  nodes: NodeOut[] | null;
  loading: boolean;
  error: boolean;
}

export interface TreeSnapshot {
  /** Bumps on every mutation note — views that show node data outside the
   *  tree (a node page, the sidebar's recent list) refetch on it. */
  revision: number;
  entries: ReadonlyMap<string, ChildrenEntry>;
}

let state: TreeSnapshot = { revision: 0, entries: new Map() };
const listeners = new Set<() => void>();
/** Request counter per key: only the newest response is applied. */
const latest = new Map<string, number>();
let seq = 0;

export const childrenKey = (spaceKey: string, parentId: string | null) => `${spaceKey}:${parentId ?? ''}`;

function emit(next: TreeSnapshot) {
  state = next;
  listeners.forEach((fn) => fn());
}

function setEntry(key: string, entry: ChildrenEntry, bump = false) {
  const entries = new Map(state.entries);
  entries.set(key, entry);
  emit({ revision: state.revision + (bump ? 1 : 0), entries });
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot(): TreeSnapshot {
  return state;
}

/** Fetches a parent's children unless they're cached (or `force`). */
export async function loadChildren(
  spaceKey: string, parentId: string | null, force = false,
): Promise<NodeOut[] | null> {
  const key = childrenKey(spaceKey, parentId);
  const current = state.entries.get(key);
  if (current && !force && (current.nodes || current.loading)) return current.nodes;
  const mine = ++seq;
  latest.set(key, mine);
  setEntry(key, { nodes: current?.nodes ?? null, loading: true, error: false });
  try {
    const nodes = await getTree(spaceKey, parentId);
    if (latest.get(key) === mine) setEntry(key, { nodes, loading: false, error: false });
    return nodes;
  } catch {
    if (latest.get(key) === mine) {
      setEntry(key, { nodes: state.entries.get(key)?.nodes ?? null, loading: false, error: true });
    }
    return null;
  }
}

/** Refetches a parent's children if anyone has loaded them. */
function refresh(spaceKey: string, parentId: string | null) {
  if (state.entries.has(childrenKey(spaceKey, parentId))) void loadChildren(spaceKey, parentId, true);
}

function bump() {
  emit({ ...state, revision: state.revision + 1 });
}

export function noteCreated(node: NodeOut): void {
  bump();
  refresh(node.space_key, node.parent_id);
}

/** `node` is the moved node as the server returned it (its new parent). */
export function noteMoved(node: NodeOut, from: { spaceKey: string; parentId: string | null }): void {
  bump();
  refresh(from.spaceKey, from.parentId);
  if (from.spaceKey !== node.space_key || from.parentId !== node.parent_id) {
    refresh(node.space_key, node.parent_id);
  }
}

/** A rename (or any other in-place change): patched at once, then refetched. */
export function noteChanged(node: NodeOut): void {
  const key = childrenKey(node.space_key, node.parent_id);
  const entry = state.entries.get(key);
  if (entry?.nodes) {
    setEntry(key, { ...entry, nodes: entry.nodes.map((n) => (n.id === node.id ? { ...n, ...node } : n)) }, true);
  } else {
    bump();
  }
  refresh(node.space_key, node.parent_id);
}

export function noteDeleted(node: Pick<NodeOut, 'space_key' | 'parent_id'>): void {
  bump();
  refresh(node.space_key, node.parent_id);
}

/** Grants changed somewhere in a space: any loaded list there may now show
 *  more or fewer nodes (or other levels), so every one is refetched. */
export function noteAccessChanged(spaceKey: string): void {
  bump();
  const prefix = `${spaceKey}:`;
  for (const key of [...state.entries.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const parentId = key.slice(prefix.length) || null;
    void loadChildren(spaceKey, parentId, true);
  }
}

/** Refetches one parent (after a failed move, the tree may be out of date). */
export function refetchChildren(spaceKey: string, parentId: string | null): void {
  refresh(spaceKey, parentId);
}

/** Tests only: forget everything. */
export function resetTreeStore(): void {
  latest.clear();
  state = { revision: 0, entries: new Map() };
}

export function useTreeSnapshot(): TreeSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useTreeRevision(): number {
  return useTreeSnapshot().revision;
}

/** The children of `parentId` (the space root when null), loading them on first use. */
export function useChildren(spaceKey: string | null, parentId: string | null): ChildrenEntry {
  const snap = useTreeSnapshot();
  useEffect(() => {
    if (spaceKey) void loadChildren(spaceKey, parentId);
  }, [spaceKey, parentId]);
  const entry = spaceKey ? snap.entries.get(childrenKey(spaceKey, parentId)) : undefined;
  return entry ?? { nodes: null, loading: !!spaceKey, error: false };
}
