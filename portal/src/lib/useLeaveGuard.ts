import { useEffect, useRef } from 'react';

/**
 * While `active`, a click on any in-app link is held and handed to
 * `onAttempt(to)` instead of navigating (the page asks first), and a reload
 * or tab close gets the browser's own "Leave site?" prompt. The app runs on
 * BrowserRouter, which has no navigation blocker, so links are caught in
 * the document's capture phase — before react-router's own handler. The
 * back button cannot be held; the page cleans up on unmount instead.
 */
export function useLeaveGuard(active: boolean, onAttempt: (to: string) => void): void {
  const attempt = useRef(onAttempt);
  attempt.current = onAttempt;
  useEffect(() => {
    if (!active) return undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      attempt.current(`${url.pathname}${url.search}${url.hash}`);
    };
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [active]);
}
