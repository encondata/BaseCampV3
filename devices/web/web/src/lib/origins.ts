/** Where the devices app's neighbors live, derived from the page's own
 *  address. Read per call, never at import (tests have no location). */
import { siblingOrigin } from '@portal/lib/siblingOrigin';

/** The portal: devices.<domain> → portal.<domain>; localhost and LAN
 *  addresses fall back to the portal's dev port on the same host. */
export function portalOrigin(): string {
  return siblingOrigin('portal', location) ?? `${location.protocol}//${location.hostname}:5173`;
}
