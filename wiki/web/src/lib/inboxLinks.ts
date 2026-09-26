/** Where an inbox item's link goes when it's opened from the wiki. The
 *  inbox is shared with the portal: a relative link is a portal path
 *  ("/reports"), so it opens on the portal; an absolute link to the wiki's
 *  own origin ("<wiki>/n/<id>") stays in the app; anything else is left
 *  as it is. Same tab, as in the portal. */
import { portalOrigin } from './origins';

export type InboxTarget = { kind: 'app'; to: string } | { kind: 'external'; href: string };

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveInboxLink(link: string): InboxTarget {
  if (ABSOLUTE.test(link) || link.startsWith('//')) {
    const url = new URL(link, location.href);
    return url.origin === location.origin
      ? { kind: 'app', to: `${url.pathname}${url.search}${url.hash}` }
      : { kind: 'external', href: url.href };
  }
  return { kind: 'external', href: `${portalOrigin()}${link.startsWith('/') ? '' : '/'}${link}` };
}

/** Leaves the wiki for `href` (its own function so tests can stub it). */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
