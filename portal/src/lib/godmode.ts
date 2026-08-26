/** God mode reveals; it never grants. An item needs BOTH its permission and
 *  — when flagged godOnly — an active god mode. The server enforces the
 *  permission on every request regardless of what the nav chooses to show. */

export interface GodGatedItem {
  resource: string;
  godOnly?: boolean;
  minRank?: number;
}

export function isNavItemVisible(
  item: GodGatedItem,
  can: (resource: string, action: 'view') => boolean,
  godMode: boolean,
  maxRank: number,
): boolean {
  if (item.minRank !== undefined && maxRank < item.minRank) return false;
  if (!can(item.resource, 'view')) return false;
  return !item.godOnly || godMode;
}
