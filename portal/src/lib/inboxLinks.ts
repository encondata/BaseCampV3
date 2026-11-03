/** Where an inbox item's link goes when it's opened from the portal. Only
 *  two kinds of link are opened. The portal's own items carry its paths, a
 *  single slash and then the rest ("/reports?tab=history"), which open
 *  in-app. Other apps that share the inbox (the wiki) send absolute http(s)
 *  URLs, which leave the portal (same tab) when they point at another
 *  origin — never through the router, which would read them as portal
 *  paths — and stay in the app on the portal's own origin. Anything else
 *  falls back to the portal's home page: a malformed absolute URL
 *  ("http://"), another scheme ("javascript:", "data:", "vbscript:"), a
 *  protocol-relative "//host" (or "/\host", which browsers read the same
 *  way), or no link at all — so a link never runs, and never leaves for
 *  somewhere unchecked. The wiki follows the same rule
 *  (wiki/web/src/lib/inboxLinks.ts): keep the two in step. */

export type InboxTarget = { kind: 'app'; to: string } | { kind: 'external'; href: string };

const HTTP_URL = /^https?:\/\//i;

/** A path: a slash and then anything but a second slash, a backslash, or the
 *  tab or newline a browser drops before reading a URL ("/\t/host" is "//host"). */
const PATH = /^\/(?![/\\\t\n\r])/;

/** Where a link that is no link we open goes: the app's home page. */
const home = (): InboxTarget => ({ kind: 'app', to: '/' });

export function resolveInboxLink(link: string): InboxTarget {
  if (!HTTP_URL.test(link)) return PATH.test(link) ? { kind: 'app', to: link } : home();
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // "http://" and the like: not a URL we can open
    return home();
  }
  return url.origin === window.location.origin
    ? { kind: 'app', to: `${url.pathname}${url.search}${url.hash}` }
    : { kind: 'external', href: url.href };
}

/** Leaves the portal for `href` (its own function so tests can stub it). */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
