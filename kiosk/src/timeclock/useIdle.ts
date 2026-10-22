import { useEffect, useRef } from 'react';

/** Calls `onIdle` once `ms` pass with no `pointerdown` or `keydown` on the
 *  window (heard in the capture phase, so a control that stops an event
 *  from bubbling still counts as activity). Does nothing while `active` is false; turning it on (or off and
 *  on) starts a fresh countdown. The latest `onIdle` is the one called, so
 *  an inline callback never restarts the timer. */
export function useIdle(active: boolean, ms: number, onIdle: () => void): void {
  const latest = useRef(onIdle);
  latest.current = onIdle;

  useEffect(() => {
    if (!active) return undefined;
    let timer = setTimeout(() => latest.current(), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), ms);
    };
    window.addEventListener('pointerdown', reset, { capture: true });
    window.addEventListener('keydown', reset, { capture: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset, { capture: true });
      window.removeEventListener('keydown', reset, { capture: true });
    };
  }, [active, ms]);
}
