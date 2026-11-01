/** Polls the public status every POLL_MS, on tab focus, and on demand
 *  (refreshSystemStatus() — fired when a write is rejected with
 *  read_only_mode). A failed poll keeps the last value: banners simply
 *  don't update, never error. Mounted above the router so the login page
 *  shares it with the shell.
 *
 *  `loaded` is false until the first answer lands. Until then `status` holds
 *  the defaults, which say email is off, so a page that would claim
 *  something from them (/me's "email isn't set up") treats not-loaded as
 *  unknown instead. A failed first fetch counts as loaded too, so nothing
 *  waits forever on a status that may never come. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { onSystemStatusRefresh } from './api';
import { DEFAULT_SYSTEM_STATUS, getSystemStatus } from './systemStatus';
import type { SystemStatus } from './systemStatus';

export const POLL_MS = 60_000;

interface Value { status: SystemStatus; loaded: boolean; refresh: () => void; }

const Ctx = createContext<Value>({ status: DEFAULT_SYSTEM_STATUS, loaded: false, refresh: () => {} });

export function SystemStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus>(DEFAULT_SYSTEM_STATUS);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    getSystemStatus()
      .then((next) => { setStatus(next); setLoaded(true); })
      .catch(() => setLoaded(true));   // the last status stays
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const off = onSystemStatusRefresh(refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      off();
    };
  }, [refresh]);

  return <Ctx.Provider value={{ status, loaded, refresh }}>{children}</Ctx.Provider>;
}

export function useSystemStatus(): Value {
  return useContext(Ctx);
}
