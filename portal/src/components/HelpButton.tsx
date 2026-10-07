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
import { useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { apiFetch } from '../lib/api';
import { helpContext, helpLinkAdminUrl, lookupHelp, openInNewTab } from '../lib/wikiHelp';

type Guide = { url: string; title: string };
type Pop = null | 'none' | 'error' | { blocked: { url: string; title: string } };

/** A cached answer lives this long, so an unlinked or retitled guide
 *  doesn't linger for the whole session. */
const CACHE_MS = 5 * 60_000;

/** Per-context answers (a guide, or null for "none yet"), the lookups still
 *  in flight (so StrictMode's double effect and quick back-and-forth share
 *  one request), and whose answers they are. */
const guideCache = new Map<string, { at: number; guide: Guide | null }>();
const inflight = new Map<string, Promise<Guide | null>>();
let cacheOwner: string | null | undefined;

/** Forget every cached answer (for tests). */
export function clearHelpCache(): void {
  guideCache.clear();
  inflight.clear();
  cacheOwner = undefined;
}

/** Answers are per person (what they may view differs): a new person, or
 *  none after sign-out, starts empty. A lookup still in flight for the
 *  old person can no longer write — it isn't in `inflight` any more.
 *  Called during render, so it mutates module state there; that is safe
 *  because it is idempotent (a no-op once the owner matches), and a render
 *  React throws away costs at worst one extra lookup. */
function scopeCacheTo(personId: string | null): void {
  if (cacheOwner === personId) return;
  guideCache.clear();
  inflight.clear();
  cacheOwner = personId;
}

/** Whether `context` has an answer young enough to skip a lookup. Only
 *  arriving at a screen asks; what's *shown* never depends on age. */
function isFresh(context: string): boolean {
  const hit = guideCache.get(context);
  return !!hit && Date.now() - hit.at < CACHE_MS;
}

/** One request per context at a time; the answer is cached, an error isn't. */
function lookupGuide(context: string): Promise<Guide | null> {
  const running = inflight.get(context);
  if (running) return running;
  const p: Promise<Guide | null> = lookupHelp(apiFetch, context).then(
    (found) => {
      const guide = found.found ? { url: found.url, title: found.title } : null;
      if (inflight.get(context) === p) {
        guideCache.set(context, { at: Date.now(), guide });
        inflight.delete(context);
      }
      return guide;
    },
    (err: unknown) => {
      if (inflight.get(context) === p) inflight.delete(context);
      throw err;
    },
  );
  inflight.set(context, p);
  return p;
}

export default function HelpButton({ onOpen }: {
  /** Called on each click — the top bar closes its other popovers. */
  onOpen?: () => void;
}) {
  const { can, person } = useAuth();
  const { pathname } = useLocation();
  // the popover belongs to the screen it was opened on
  const [popState, setPopState] = useState<{ context: string; pop: Pop } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const canView = can('wiki', 'view');
  const personId = person?.id ?? null;
  const context = helpContext('portal', pathname);
  const pop = popState?.context === context ? popState.pop : null;
  const setPop = (p: Pop) => setPopState(p ? { context, pop: p } : null);
  scopeCacheTo(personId);
  // read from the cache for *this* screen on every render, so the old
  // screen's guide is never shown (or opened) after navigating; an answer
  // past its five minutes still shows until the arrival lookup replaces it
  const guide = canView ? guideCache.get(context)?.guide ?? null : null;
  const wrapRef = useRef<HTMLDivElement>(null);
  // the newest click retires older ones; leaving the screen retires them too
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    setPopState(null);
    setBusy(false);
    if (!canView || isFresh(context)) return;
    // the answer lands in the cache; re-render to pick it up if still here
    lookupGuide(context).then(refresh, () => { /* a click tries again */ });
  }, [context, canView, personId]);

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
      const found = await lookupGuide(context);
      refresh();
      if (mine !== seq.current) return;
      if (!found) setPop('none');
      else if (!openInNewTab(found.url)) setPop({ blocked: found });
    } catch {
      if (mine === seq.current) setPop('error');
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // one tooltip everywhere (Jimmy, 2026-10-06); the accent says a guide exists
  const label = 'Show Guide On Wiki';
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
