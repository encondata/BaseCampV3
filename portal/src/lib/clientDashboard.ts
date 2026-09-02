/**
 * Pure Client Dashboard helpers — initiative ordering and fleet
 * distribution. No React, no fetching.
 */

import type { AssetItem, InitiativeItem, StatusValue } from './api';
import type { DistEntry } from '../components/dashboard/charts';

/** Unarchived only; active (no real_end_at) before finished; within each
 *  group newest scheduled_start first, missing dates last. */
export function sortClientInitiatives(list: InitiativeItem[]): InitiativeItem[] {
  const rank = (i: InitiativeItem) => (i.real_end_at ? 1 : 0);
  const start = (i: InitiativeItem) => i.scheduled_start ?? '';
  return list
    .filter((i) => !i.archived_at)
    .sort((a, b) => rank(a) - rank(b)
      || (start(a) < start(b) ? 1 : start(a) > start(b) ? -1 : 0));
}

export function assetDistribution(
  assets: AssetItem[], statuses: StatusValue[],
): DistEntry[] {
  const counts = new Map<string, number>();
  for (const a of assets) {
    if (a.archived_at) continue;
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  }
  const vocab = new Map(statuses.map((s) => [s.key, s]));
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: vocab.get(key)?.label ?? key,
      color: vocab.get(key)?.color ?? '#51606f',
      count,
    }))
    .sort((a, b) => b.count - a.count);
}
