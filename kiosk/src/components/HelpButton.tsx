/**
 * The kiosk top bar's ? button — the portal's top-bar help button, for
 * the kiosk (whose React may not import the portal's .tsx). Signed in
 * with wiki:view and online only: asks the wiki for this screen's guide
 * (`kiosk:<pathname>`, via the kiosk's own apiFetch) and opens it in a new
 * tab. With none yet, a small popover says so — and offers wiki admins
 * (wiki:delete) "Link a guide", which opens the wiki's Help links page
 * with this screen's context filled in.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { helpContext, helpLinkAdminUrl, lookupHelp, openInNewTab } from '@portal/lib/wikiHelp';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { apiFetch } from '../lib/api';
import { useOnline } from '../lib/online';

type Pop = null | 'none' | 'error';

export default function HelpButton() {
  const { status, can } = useKioskAuth();
  const online = useOnline();
  const { pathname } = useLocation();
  const [pop, setPop] = useState<Pop>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // the newest lookup wins: a tap, or leaving the screen, retires older ones
  const seq = useRef(0);

  useEffect(() => { seq.current += 1; setPop(null); setBusy(false); }, [pathname]);

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

  if (status !== 'authed' || !online || !can('wiki', 'view')) return null;
  const context = helpContext('kiosk', pathname);

  const onClick = async () => {
    if (pop) { setPop(null); return; }
    const mine = ++seq.current;
    setBusy(true);
    try {
      const found = await lookupHelp(apiFetch, context);
      if (mine !== seq.current) return;
      if (found.found) openInNewTab(found.url);
      else setPop('none');
    } catch {
      if (mine === seq.current) setPop('error');
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  return (
    <div className="pop-wrap kiosk-help" ref={wrapRef}>
      <button type="button" className="icon-btn" aria-label="Help for this page" title="Help for this page"
              aria-busy={busy} disabled={busy} onClick={() => void onClick()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
        </svg>
      </button>
      {pop && (
        <div className="pop-menu" role="dialog" aria-label="Help">
          <div className="pop-title">Help</div>
          <div className="pop-empty">
            {pop === 'none' ? 'No guide for this page yet' : 'Couldn’t look up a guide. Try again.'}
          </div>
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
