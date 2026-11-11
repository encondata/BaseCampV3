/** The Linux laptop's battery and network from the kiosk helper, polled
 *  while mounted. Off a Linux laptop it never fetches and stays null. A
 *  failed poll keeps the last answer. */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getHostSystem, lockdownAvailable, type HostSystem } from './hostHelper';

export const HOST_POLL_MS = 15_000;   // assumption: the same as EDGE_POLL_MS

export function useHostSystem(): { system: HostSystem | null; refresh: () => Promise<void> } {
  const [system, setSystem] = useState<HostSystem | null>(null);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    if (!lockdownAvailable()) return;
    try {
      const next = await getHostSystem();
      if (live.current) setSystem(next);
    } catch { /* keep the last answer */ }
  }, []);
  useEffect(() => {
    live.current = true;
    if (!lockdownAvailable()) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), HOST_POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [refresh]);
  return { system, refresh };
}
