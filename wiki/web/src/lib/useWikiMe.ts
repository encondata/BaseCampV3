/** The signed-in person's wiki capabilities (`GET /wiki/me`), fetched once
 *  per person and shared by every caller. */
import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import type { MeOut } from './types';
import { getMe } from './wikiApi';

const cache = new Map<string, Promise<MeOut>>();

function meFor(personId: string): Promise<MeOut> {
  let p = cache.get(personId);
  if (!p) {
    p = getMe();
    // a failed read is retried by the next caller rather than cached
    p.catch(() => cache.delete(personId));
    cache.set(personId, p);
  }
  return p;
}

/** Forget the cached answer (sign-out, tests). */
export function clearWikiMe(): void {
  cache.clear();
}

/** null while loading (or when the read failed — treat as "no extras"). */
export function useWikiMe(): MeOut | null {
  const { person } = useAuth();
  const personId = person?.id ?? null;
  const [me, setMe] = useState<{ personId: string; me: MeOut } | null>(null);
  useEffect(() => {
    if (!personId) return;
    let live = true;
    meFor(personId).then((m) => { if (live) setMe({ personId, me: m }); }).catch(() => {});
    return () => { live = false; };
  }, [personId]);
  return me && me.personId === personId ? me.me : null;
}
