/** The one call the public share view (`/p/:token`) makes. It goes
 *  straight to `fetch` — not the portal's apiFetch, which carries the
 *  signed-in session and refreshes it — with credentials omitted, so a
 *  shared link behaves the same in a fresh private window as anywhere else. */
import { apiUrl } from '@portal/lib/api';

import type { PublicShareOut } from './types';

export class PublicShareError extends Error {
  constructor(readonly status: number) {
    super(`public share: HTTP ${status}`);
    this.name = 'PublicShareError';
  }
}

/** 404 for every way a link can be unusable; 429 past the rate limit. */
export async function getPublicShare(token: string): Promise<PublicShareOut> {
  const resp = await fetch(`${apiUrl()}/wiki/public/${encodeURIComponent(token)}`, {
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!resp.ok) throw new PublicShareError(resp.status);
  return resp.json() as Promise<PublicShareOut>;
}
