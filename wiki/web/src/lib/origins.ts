/** Where the wiki's neighbors live, derived from the page's own address.
 *  Read per call, never at import (tests and the server have no location). */
import { siblingOrigin } from '@portal/lib/siblingOrigin';

/** The portal: wiki.<domain> → portal.<domain>; localhost and LAN
 *  addresses fall back to the portal's dev port on the same host. */
export function portalOrigin(): string {
  return siblingOrigin('portal', location) ?? `${location.protocol}//${location.hostname}:5173`;
}

/** The live-editing socket: the wiki server's /collab on this same origin
 *  (Vite proxies it to the wiki server in dev). */
export function collabUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
}
