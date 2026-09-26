/** Whether the browser says this kiosk has a network (`navigator.onLine`,
 *  kept current by the window's online/offline events). "Online" here only
 *  means a network is up, not that the API answers — good enough to hide
 *  things that can't work without one. */
import { useEffect, useState } from 'react';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
