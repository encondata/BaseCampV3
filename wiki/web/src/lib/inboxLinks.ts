/** Where an inbox item's link goes when it's opened from the wiki. The
 *  inbox is shared with the portal, and this follows the portal's rule
 *  (portal/src/lib/inboxLinks.ts) with the wiki as the home app: only an
 *  absolute http(s) URL is a URL — on the wiki's own origin ("<wiki>/n/<id>")
 *  it stays in the app, elsewhere it leaves (same tab), and one that can't
 *  be parsed ("http://") stays on the wiki's home page. Anything else — a
 *  portal path ("/reports"), a protocol-relative "//host", or another
 *  scheme ("javascript:") — is read as a portal path, so it opens on the
 *  portal and never runs or leaves for somewhere unchecked. */
import { portalOrigin } from './origins';

export type InboxTarget = { kind: 'app'; to: string } | { kind: 'external'; href: string };

const HTTP_URL = /^https?:\/\//i;

export function resolveInboxLink(link: string): InboxTarget {
  if (!HTTP_URL.test(link)) {
    return { kind: 'external', href: `${portalOrigin()}${link.startsWith('/') ? '' : '/'}${link}` };
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { kind: 'app', to: '/' };
  }
  return url.origin === location.origin
    ? { kind: 'app', to: `${url.pathname}${url.search}${url.hash}` }
    : { kind: 'external', href: url.href };
}

/** Leaves the wiki for `href` (its own function so tests can stub it). */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
