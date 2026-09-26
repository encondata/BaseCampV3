/** Where an inbox item's link goes when it's opened from the portal. The
 *  portal's own items carry relative paths ("/reports?tab=history"),
 *  which open in-app; other apps that share the inbox (the wiki) send
 *  absolute http(s) URLs, which leave the portal (same tab) when they
 *  point at another origin — never through the router, which would read
 *  them as portal paths. An absolute URL on the portal's own origin
 *  stays in the app, as does a malformed absolute link (to the portal's
 *  home page). */

export type InboxTarget = { kind: 'app'; to: string } | { kind: 'external'; href: string };

const HTTP_URL = /^https?:\/\//i;

export function resolveInboxLink(link: string): InboxTarget {
  if (!HTTP_URL.test(link)) return { kind: 'app', to: link };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // "http://" and the like: not a URL we can open — stay in the app
    return { kind: 'app', to: '/' };
  }
  return url.origin === window.location.origin
    ? { kind: 'app', to: `${url.pathname}${url.search}${url.hash}` }
    : { kind: 'external', href: url.href };
}

/** Leaves the portal for `href` (its own function so tests can stub it). */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
