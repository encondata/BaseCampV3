/** A fresh portal access token for the live-editing socket (the Hocuspocus
 *  provider asks on every connect and reconnect). The portal keeps the
 *  token in memory (`getAccessTokenForStream`); when it's missing or about
 *  to expire, this refreshes the session first (`refreshSession`, which
 *  is single-flight and uses the httpOnly refresh cookie). */
import { getAccessTokenForStream, refreshSession } from '@portal/lib/api';

/** Refresh when less than this is left (the portal's own margin). */
const MARGIN_MS = 30_000;

/** The token's `exp` in epoch ms, or null when it isn't a readable JWT. */
function expiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function currentAccessToken(): Promise<string> {
  const token = getAccessTokenForStream();
  if (token) {
    const exp = expiresAt(token);
    if (exp === null || exp - Date.now() > MARGIN_MS) return token;
  }
  const refreshed = await refreshSession();
  const fresh = refreshed?.access_token ?? getAccessTokenForStream();
  // a failed refresh (network hiccup) keeps trying with what we have; the
  // server refuses it if it has really expired
  if (fresh && fresh !== token) return fresh;
  if (token) return token;
  throw new Error('You are no longer signed in.');
}
