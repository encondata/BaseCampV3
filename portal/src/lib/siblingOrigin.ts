/**
 * Where the API lives when the app is served from a real hostname rather
 * than localhost.
 *
 * The dev and production stacks put each piece on its own subdomain of a
 * shared parent — portal.dev.serversherpa.com, kiosk.dev.serversherpa.com,
 * api.dev.serversherpa.com — so a front end can find its API by swapping
 * the first label of its own hostname. That keeps one build working
 * behind any of those names without a per-environment env file.
 *
 * Deliberately narrow, so nothing that works today changes:
 *   - localhost and bare hostnames fall through (the caller's :8000 default
 *     still applies), because there is no sibling to swap to;
 *   - IP literals fall through, so a phone hitting the dev box by LAN
 *     address keeps using the port-based default;
 *   - fewer than three labels falls through, so example.com never becomes
 *     api.com.
 * The protocol follows the page, so an HTTPS front end never reaches for
 * an HTTP API and trips mixed-content blocking.
 */

export interface LocationLike {
  hostname: string;
  protocol: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** `siblingOrigin('api', location)` → "https://api.dev.serversherpa.com",
 *  or null when this host has no sibling to point at. */
export function siblingOrigin(label: string, loc: LocationLike): string | null {
  const host = loc.hostname.trim().toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
  if (IPV4.test(host) || host.includes(':')) return null;  // IPv4 / IPv6 literal

  const labels = host.split('.');
  if (labels.length < 3) return null;
  if (labels[0] === label) return `${loc.protocol}//${host}`;

  return `${loc.protocol}//${[label, ...labels.slice(1)].join('.')}`;
}
