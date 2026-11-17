/**
 * Container positions for the location hover map (LocationMapPreview).
 *
 * Hovering the same location again, or several rows that share a crate,
 * should not refetch, so answers are cached per container id for a
 * minute. The in-flight promise is cached first, so concurrent hovers
 * share one request; a failure drops the entry so the next hover tries
 * again.
 */

import { getContainerPosition, type ContainerPosition } from './api';
import { relativeTime } from './format';

export const POSITION_TTL_MS = 60_000;

const cache = new Map<string, { at: number; promise: Promise<ContainerPosition> }>();

export function loadContainerPosition(
  id: string, now = Date.now(),
): Promise<ContainerPosition> {
  const hit = cache.get(id);
  if (hit && now - hit.at <= POSITION_TTL_MS) return hit.promise;
  const promise = getContainerPosition(id);
  const entry = { at: now, promise };
  cache.set(id, entry);
  promise.catch(() => {
    // Only drop our own entry: a newer request may have replaced it.
    if (cache.get(id) === entry) cache.delete(id);
  });
  return promise;
}

/** For tests. */
export function clearPositionCache(): void {
  cache.clear();
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

/** The card's text: a title above the map, then a detail line or a
 *  muted note below it. */
export function positionLines(p: ContainerPosition): {
  title: string; detail: string; note: string | null;
} {
  const name = p.name ?? '';
  if (p.kind === 'truck') {
    if (p.lat === null || p.lng === null || !p.recorded_at) {
      return { title: name, detail: '', note: `${name} hasn't reported a position yet` };
    }
    let detail = `Last report ${hhmm(p.recorded_at)} · ${relativeTime(p.recorded_at)}`;
    if (p.approximate_address) detail += ` · ${p.approximate_address}`;
    return { title: name, detail, note: null };
  }
  if (p.kind === 'site') {
    return { title: name, detail: 'Site location, not a live position', note: null };
  }
  return { title: '', detail: '', note: 'No known position' };
}
