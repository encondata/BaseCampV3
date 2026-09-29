/** Where the wiki lives, derived from the page's own address (mirrors
 *  wiki/web/src/lib/origins.ts's portalOrigin, the same idea in reverse).
 *  Read per call, never at import — this file is React-free and needs no
 *  `window`/`location` until something actually calls it, which keeps it
 *  safe to reference from data tables loaded in a bare node test
 *  environment (see portal/src/layout/navSections.tsx). */
import { siblingOrigin } from './siblingOrigin';

export function wikiOrigin(): string {
  return siblingOrigin('wiki', location) ?? `${location.protocol}//${location.hostname}:5176`;
}
