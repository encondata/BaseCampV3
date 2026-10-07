/**
 * The top bar's ? button (wiki:view only): asks the wiki for this screen's
 * guide (`portal:<pathname>`, see lib/wikiHelp.ts) and opens it in a new
 * tab. With none yet, a small popover says so — and offers wiki admins
 * (wiki:delete) "Link a guide", which opens the wiki's Help links page with
 * this screen's context filled in. If the browser blocks the new tab (a
 * slow lookup can outlast the click's permission to open one), the
 * popover offers the guide as a link instead.
 *
 * The screen is also looked up on load and on every navigation (answers
 * cached per context for the session): when it has a guide the ? turns the
 * user's accent color and names the guide, and a click opens it at once —
 * no lookup, so the browser's permission to open a tab hasn't run out.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { apiFetch } from '../lib/api';
import { helpContext, helpLinkAdminUrl, lookupHelp, openInNewTab } from '../lib/wikiHelp';

type Guide = { url: string; title: string };
type Pop = null | 'none' | 'error' | { blocked: { url: string; title: string } };

/** Per-context answers for the session: a guide, or null for "none yet". */
const guideCache = new Map<string, Guide | null>();

/** Forget every cached answer (for tests). */
export function clearHelpCache(): void { guideCache.clear(); }

export default function HelpButton({ onOpen }: {
  /** Called on each click — the top bar closes its other popovers. */
  onOpen?: () => void;
}) {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const [pop, setPop] = useState<Pop>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState<Guide | null>(null);
  const canView = can('wiki', 'view');
  const context = helpContext('portal', pathname);
  const wrapRef = useRef<HTMLDivElement>(null);
  // the newest lookup wins: a click, or leaving the screen, retires older ones
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setPop(null);
    setBusy(false);
    setGuide(null);
    if (!canView) return;
    if (guideCache.has(context)) { setGuide(guideCache.get(context) ?? null); return; }
    lookupHelp(apiFetch, context).then((found) => {
      const answer = found.found ? { url: found.url, title: found.title } : null;
      guideCache.set(context, answer);
      if (mine === seq.current) setGuide(answer);
    }, () => { /* not cached: the button stays normal and a click tries again */ });
  }, [context, canView]);

  useEffect(() => {
    if (!pop) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPop(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [pop]);

  if (!canView) return null;

  const onClick = async () => {
    onOpen?.();
    if (pop) { setPop(null); return; }
    if (guide) {
      if (!openInNewTab(guide.url)) setPop({ blocked: guide });
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    try {
      const found = await lookupHelp(apiFetch, context);
      guideCache.set(context, found.found ? { url: found.url, title: found.title } : null);
      if (mine !== seq.current) return;
      if (found.found) setGuide({ url: found.url, title: found.title });
      if (!found.found) setPop('none');
      else if (!openInNewTab(found.url)) setPop({ blocked: { url: found.url, title: found.title } });
    } catch {
      if (mine === seq.current) setPop('error');
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const label = guide ? `Guide for this page: “${guide.title}”` : 'Help for this page';
  return (
    <div className="pop-wrap" ref={wrapRef}>
      <button className={guide ? 'icon-btn has-guide' : 'icon-btn'} data-tip={label} aria-label={label}
              aria-busy={busy} disabled={busy} onClick={() => void onClick()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
        </svg>
      </button>
      {pop && (
        <div className="pop-menu" role="dialog" aria-label="Help">
          <div className="pop-title">Help</div>
          {typeof pop === 'object' ? (
            <a className="pop-item" href={pop.blocked.url} target="_blank" rel="noopener noreferrer"
               onClick={() => setPop(null)}>
              Open “{pop.blocked.title}”
            </a>
          ) : (
            <div className="pop-empty">
              {pop === 'none' ? 'No guide for this page yet' : 'Couldn’t look up a guide. Try again.'}
            </div>
          )}
          {pop === 'none' && can('wiki', 'delete') && (
            <button type="button" className="pop-item"
                    onClick={() => { setPop(null); openInNewTab(helpLinkAdminUrl(context)); }}>
              Link a guide
            </button>
          )}
        </div>
      )}
    </div>
  );
}
