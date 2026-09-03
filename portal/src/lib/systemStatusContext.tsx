/** Polls the public status every POLL_MS, on tab focus, and on demand
 *  (refreshSystemStatus() — fired when a write is rejected with
 *  read_only_mode). A failed poll keeps the last value: banners simply
 *  don't update, never error. Mounted above the router so the login page
 *  shares it with the shell. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { onSystemStatusRefresh } from './api';
import { DEFAULT_SYSTEM_STATUS, getSystemStatus } from './systemStatus';
import type { SystemStatus } from './systemStatus';

export const POLL_MS = 60_000;

interface Value { status: SystemStatus; refresh: () => void; }

const Ctx = createContext<Value>({ status: DEFAULT_SYSTEM_STATUS, refresh: () => {} });

export function SystemStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus>(DEFAULT_SYSTEM_STATUS);

  const refresh = useCallback(() => {
    getSystemStatus().then(setStatus).catch(() => { /* keep last value */ });
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

  return <Ctx.Provider value={{ status, refresh }}>{children}</Ctx.Provider>;
}

export function useSystemStatus(): Value {
  return useContext(Ctx);
}
