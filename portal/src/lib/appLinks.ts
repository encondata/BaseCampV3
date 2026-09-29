/**
 * Where the sibling apps live, for the nav's Kiosk and Wiki links.
 *
 * Same rule the API lookup uses: on a real hostname, swap the first label
 * (portal.dev.serversherpa.com → kiosk.dev.serversherpa.com); on localhost
 * or an IP, fall back to the app's dev port. VITE_KIOSK_URL / VITE_WIKI_URL
 * override both, for a stack that hosts an app somewhere else.
 */

import { siblingOrigin, type LocationLike } from './siblingOrigin';

export const KIOSK_DEV_PORT = 5174;
export const WIKI_DEV_PORT = 5176;

function trim(url: string | undefined): string | undefined {
  const v = url?.trim().replace(/\/+$/, '');
  return v ? v : undefined;
}

/** The origin of a sibling app: the env override, the sibling hostname, or
 *  this host on the app's dev port. */
export function appOrigin(label: string, devPort: number, loc: LocationLike & { host?: string },
                          override?: string): string {
  const forced = trim(override);
  if (forced) return forced;
  const sibling = siblingOrigin(label, loc);
  if (sibling) return sibling;
  return `${loc.protocol}//${loc.hostname}:${devPort}`;
}

/** The page's location, or a localhost stand-in where there is no window
 *  (node-environment tests import the nav data at module load). */
function pageLocation(): LocationLike {
  return typeof window === 'undefined' ? { hostname: 'localhost', protocol: 'http:' } : window.location;
}

export function kioskUrl(loc: LocationLike = pageLocation()): string {
  return appOrigin('kiosk', KIOSK_DEV_PORT, loc, import.meta.env.VITE_KIOSK_URL as string | undefined);
}

export function wikiUrl(loc: LocationLike = pageLocation()): string {
  return appOrigin('wiki', WIKI_DEV_PORT, loc, import.meta.env.VITE_WIKI_URL as string | undefined);
}
