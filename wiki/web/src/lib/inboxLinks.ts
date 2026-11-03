/** Where an inbox item's link goes when it's opened from the wiki. The
 *  inbox is shared with the portal, and this follows the portal's rule
 *  (portal/src/lib/inboxLinks.ts) with the wiki as the home app: only two
 *  kinds of link are opened. An absolute http(s) URL on the wiki's own
 *  origin ("<wiki>/n/<id>") stays in the app, and one on another origin
 *  leaves (same tab). A portal path, a single slash and then the rest
 *  ("/reports"), opens on the portal. Anything else falls back to the
 *  wiki's home page: a malformed absolute URL ("http://"), another scheme
 *  ("javascript:", "data:", "vbscript:"), a protocol-relative "//host" (or
 *  "/\host", which browsers read the same way), or no link at all — so a
 *  link never runs, and never leaves for somewhere unchecked. Keep the two
 *  in step. */
import { portalOrigin } from './origins';

export type InboxTarget = { kind: 'app'; to: string } | { kind: 'external'; href: string };

const HTTP_URL = /^https?:\/\//i;

/** A path: a slash and then anything but a second slash, a backslash, or the
 *  tab or newline a browser drops before reading a URL ("/\t/host" is "//host"). */
const PATH = /^\/(?![/\\\t\n\r])/;

/** Where a link that is no link we open goes: the app's home page. */
const home = (): InboxTarget => ({ kind: 'app', to: '/' });

export function resolveInboxLink(link: string): InboxTarget {
  if (!HTTP_URL.test(link)) {
    return PATH.test(link) ? { kind: 'external', href: `${portalOrigin()}${link}` } : home();
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // "http://" and the like: not a URL we can open
    return home();
  }
  return url.origin === location.origin
    ? { kind: 'app', to: `${url.pathname}${url.search}${url.hash}` }
    : { kind: 'external', href: url.href };
}

/** Leaves the wiki for `href` (its own function so tests can stub it). */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
