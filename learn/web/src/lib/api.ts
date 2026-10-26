/** Where the API lives and the two public sign-in calls (a learning code
 *  plus last name, or the invite link's token). Everything after sign-in
 *  goes through `learnFetch` in session.ts. */
import { ApiError, apiUrl } from '@portal/lib/api';

declare global {
  interface Window {
    /** Written by the Docker entrypoint (docker/entrypoint.sh) before the
     *  bundle loads; empty in dev. */
    __LEARN_CONFIG__?: { apiUrl?: string };
  }
}

/** The container's configured API, else the portal's rule (VITE_API_URL,
 *  then learn.<domain> → api.<domain>, then this host's :8000). Read per
 *  call, never at import. */
export function learnApiUrl(): string {
  const configured = typeof window !== 'undefined' ? window.__LEARN_CONFIG__?.apiUrl : undefined;
  return configured ? configured.replace(/\/+$/, '') : apiUrl();
}

export interface LearnSession {
  token: string;
  expires_at: string;
  person: { first_name: string };
}

/** A code is 6 characters of Crockford base32. Uppercased, with anything
 *  else dropped, and the look-alikes Crockford never issues read as the
 *  digits they resemble (O → 0, I and L → 1). */
const LOOK_ALIKES: Record<string, string> = { O: '0', I: '1', L: '1' };
const CODE_CHAR = /[0-9A-HJKMNP-TV-Z]/;

export function normalizeCode(raw: string): string {
  return [...raw.toUpperCase()]
    .map((c) => LOOK_ALIKES[c] ?? c)
    .filter((c) => CODE_CHAR.test(c))
    .join('');
}

/** A failed call as an ApiError (status + detail.code); a network failure
 *  is code `network`, status 0. */
async function post<T>(path: string, body: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${learnApiUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!resp.ok) {
    let code = 'unknown_error';
    let detail: unknown;
    try {
      detail = (await resp.json())?.detail;
      const c = (detail as { code?: unknown } | undefined)?.code;
      if (typeof c === 'string') code = c;
    } catch { /* non-JSON error body */ }
    throw new ApiError(resp.status, code, detail);
  }
  return resp.json() as Promise<T>;
}

export function signInWithCode(code: string, lastName: string): Promise<LearnSession> {
  return post('/learn/auth/code', { code: normalizeCode(code), last_name: lastName.trim() });
}

export function signInWithLink(token: string): Promise<LearnSession> {
  return post('/learn/auth/link', { token });
}
