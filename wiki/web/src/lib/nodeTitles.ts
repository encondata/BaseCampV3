/** Current titles of linked nodes (page links show the live title, never
 *  the one stored in the document), cached for two minutes — and whether
 *  the viewer may print it (an embedded file's preview depends on that).
 *  A node that's gone or not viewable answers null; other failures reject
 *  and are retried by the next caller. */
import { ApiError } from '@portal/lib/api';

import { getNode } from './wikiApi';

const TTL_MS = 2 * 60_000;
export interface NodeInfo { title: string; canPrint: boolean }

const infos = new Map<string, { at: number; info: Promise<NodeInfo | null> }>();

export function nodeInfo(id: string): Promise<NodeInfo | null> {
  const hit = infos.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const info = getNode(id).then((n) => ({ title: n.title, canPrint: n.can_print !== false })).catch((err: unknown) => {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    infos.delete(id);
    throw err;
  });
  infos.set(id, { at: Date.now(), info });
  return info;
}

export function nodeTitle(id: string): Promise<string | null> {
  return nodeInfo(id).then((i) => i?.title ?? null);
}

/** Forget every cached title (sign-out; tests). */
export function clearNodeTitles(): void {
  infos.clear();
}
