/** The ? help button's lookup (the portal's top bar). React-free, so a
 *  kiosk button could share it once kiosk sessions have a way to reach a
 *  guide — today they're refused on every /wiki/* route. A screen is named
 *  `<app>:<location.pathname>`; the API normalizes it (case, trailing
 *  slash, ids → `:id`) and answers with the longest-matching guide the
 *  person can view, or 404. Each app passes its own authenticated fetch. */
import { wikiOrigin } from './wikiOrigin';

export type HelpApp = 'portal' | 'kiosk';

export type HelpLookup = { found: true; url: string; title: string } | { found: false };

export function helpContext(app: HelpApp, pathname: string): string {
  return `${app}:${pathname}`;
}

/** `GET /wiki/help?context=` through `fetcher` (the app's apiFetch): 404
 *  is "no guide yet"; any other failure throws. */
export async function lookupHelp(
  fetcher: (path: string) => Promise<Response>, context: string,
): Promise<HelpLookup> {
  const resp = await fetcher(`/wiki/help?context=${encodeURIComponent(context)}`);
  if (resp.status === 404) return { found: false };
  if (!resp.ok) throw new Error(`help lookup failed (${resp.status})`);
  const body = await resp.json() as { url: string; title: string };
  return { found: true, url: body.url, title: body.title };
}

/** The wiki's Help links page with the add form open on `context` —
 *  "Link a guide", for wiki admins. */
export function helpLinkAdminUrl(context: string): string {
  return `${wikiOrigin()}/admin/help-links?context=${encodeURIComponent(context)}`;
}

/** A new tab that can't reach back into this one. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}
