/**
 * Which server a laptop kiosk talks to, as the screens show it: the
 * Settings › This Kiosk picker row and the non-Prod badge in the shell's
 * footer and on the sign-in page. The edge owns the choice (GET
 * /edge/environment); the plain web kiosk has no picker or badge, since
 * the address it was loaded from already names its environment.
 */

import { useEffect, useState } from 'react';

import { getEdgeEnvironment, type EdgeEnvironment } from './api';
import { isLaptop } from './platform';

export type { EdgeEnvironment };

/** The laptop's current environment, asked once per mount. Null on the
 *  plain web kiosk (nothing is asked), until the edge answers, and when it
 *  can't be asked. */
export function useEdgeEnvironment(): EdgeEnvironment | null {
  const [env, setEnv] = useState<EdgeEnvironment | null>(null);
  useEffect(() => {
    if (!isLaptop()) return undefined;
    let live = true;
    getEdgeEnvironment().then((next) => { if (live) setEnv(next); }, () => undefined);
    return () => { live = false; };
  }, []);
  return env;
}

/** The environment's name, or `Custom` for typed URLs. */
export function environmentName(env: EdgeEnvironment): string {
  return env.kind === 'custom' ? 'Custom' : env.name;
}

/** What the non-Prod badge reads. Null on Prod (no badge) and while
 *  unknown. */
export function environmentBadge(env: EdgeEnvironment | null): string | null {
  return !env || env.is_prod ? null : environmentName(env);
}

/** The Server row: a named environment's API host, or a custom
 *  environment's whole API URL. */
export function serverLabel(env: EdgeEnvironment): string {
  if (env.kind === 'custom') return env.api_url;
  try {
    return new URL(env.api_url).host;
  } catch {
    return env.api_url;
  }
}
