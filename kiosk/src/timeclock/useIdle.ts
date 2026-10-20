import { useEffect, useRef } from 'react';

/** Calls `onIdle` once `ms` pass with no `pointerdown` or `keydown` on the
 *  window. Does nothing while `active` is false; turning it on (or off and
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
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [active, ms]);
}
