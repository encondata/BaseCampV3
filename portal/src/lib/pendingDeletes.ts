/**
 * Shared god-mode "pending delete" state: the developer-only mark/unmark
 * flow that flags a directory row for the Task 1 devtools hard-delete
 * reconcile, without deleting anything itself. Every directory page wires
 * one `usePendingDeletes(godMode)` and hands `pendingIds` / `mark` /
 * `unmark` down to its rows' <GodDeleteButton>s.
 *
 * The API keys DELETE off the *marker's* id, not the entity's (see
 * DELETE /devtools/pending-deletes/{marker_id}) — this hook hides that
 * indirection behind an entityId-keyed `unmark`, so callers never have to
 * track marker ids themselves.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  listPendingDeletes, markPendingDelete, unmarkPendingDelete,
  type PendingDeleteItem, type PendingDeleteReference,
} from './api';

/** Whether force delete can actually detach every listed reference: it
 *  purges association rows and nulls nullable columns, but a check-guarded
 *  column (processed_scans match FKs) can't be nulled without tripping the
 *  CHECK — offering Force there would just fail and roll back. */
export function canForceDelete(references: PendingDeleteReference[]): boolean {
  return references.length > 0
    && references.every((r) => (r.nullable && !r.check_guarded) || r.purgeable);
}

/** entityId -> markerId, the lookup `unmark` needs. Split out from the
 *  hook body so it's testable without React or a mocked fetch. */
export function markerIdsByEntity(items: PendingDeleteItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) map.set(item.entity_id, item.id);
  return map;
}

export interface PendingDeletesState {
  pendingIds: Set<string>;
  mark: (entityType: string, entityId: string, label: string) => Promise<void>;
  unmark: (entityId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePendingDeletes(enabled: boolean): PendingDeletesState {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [markerIds, setMarkerIds] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    // Never fetches for normal users — `enabled` (the page's godMode) gates
    // this call as well as the effect below that triggers it.
    if (!enabled) return;
    const items = await listPendingDeletes();
    setMarkerIds(markerIdsByEntity(items));
    setPendingIds(new Set(items.map((i) => i.entity_id)));
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    } else {
      // godMode was exited mid-session — drop stale markers rather than
      // leave last session's pending chips/buttons showing.
      setPendingIds(new Set());
      setMarkerIds(new Map());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const mark = useCallback(async (entityType: string, entityId: string, label: string) => {
    const created = await markPendingDelete(entityType, entityId, label);
    setPendingIds((ids) => new Set(ids).add(entityId));
    setMarkerIds((map) => new Map(map).set(entityId, created.id));
  }, []);

  const unmark = useCallback(async (entityId: string) => {
    const markerId = markerIds.get(entityId);
    if (!markerId) return; // nothing tracked for this id — stale click, ignore
    await unmarkPendingDelete(markerId);
    setPendingIds((ids) => {
      const next = new Set(ids);
      next.delete(entityId);
      return next;
    });
    setMarkerIds((map) => {
      const next = new Map(map);
      next.delete(entityId);
      return next;
    });
  }, [markerIds]);

  return { pendingIds, mark, unmark, refresh };
}
