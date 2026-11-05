/** God mode reveals; it never grants. An item needs BOTH its permission and
 *  — when flagged godOnly — an active god mode. The server enforces the
 *  permission on every request regardless of what the nav chooses to show. */

import { canManageLearning, type Action } from './access';

export interface GodGatedItem {
  resource: string;
  /** Gated like the API's learning routes: `learning:view` OR a global
   *  `wiki:delete` — so a wiki administrator without the learning resource
   *  still sees it. Replaces the plain `resource` check. */
  learningManager?: boolean;
  godOnly?: boolean;
  minRank?: number;
  globalOnly?: boolean;
  /** A link to an optional app: hidden while the environment runs it off. */
  app?: 'wiki' | 'kiosk';
}

export function isNavItemVisible(
  item: GodGatedItem,
  can: (resource: string, action: Action) => boolean,
  godMode: boolean,
  maxRank: number,
  isGlobal: boolean,
  appOn: (app: 'wiki' | 'kiosk') => boolean = () => true,
): boolean {
  if (item.app && !appOn(item.app)) return false;
  if (item.globalOnly && !isGlobal) return false;
  if (item.minRank !== undefined && maxRank < item.minRank) return false;
  if (item.learningManager) {
    if (!canManageLearning({ can, isGlobal })) return false;
  } else if (item.resource && !can(item.resource, 'view')) return false;
  return !item.godOnly || godMode;
}
