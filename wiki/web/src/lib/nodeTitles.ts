/** Current titles of linked nodes (page links show the live title, never
 *  the one stored in the document), cached for two minutes. A node that's
 *  gone or not viewable answers null; other failures reject and are
 *  retried by the next caller. */
import { ApiError } from '@portal/lib/api';

import { getNode } from './wikiApi';

const TTL_MS = 2 * 60_000;
const titles = new Map<string, { at: number; title: Promise<string | null> }>();

export function nodeTitle(id: string): Promise<string | null> {
  const hit = titles.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.title;
  const title = getNode(id).then((n) => n.title).catch((err: unknown) => {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    titles.delete(id);
    throw err;
  });
  titles.set(id, { at: Date.now(), title });
  return title;
}

/** Forget every cached title (sign-out; tests). */
export function clearNodeTitles(): void {
  titles.clear();
}
