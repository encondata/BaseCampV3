/** Who is signed in to the learn site, and the fetch every signed-in call
 *  goes through.
 *
 *  - A worker signed in with a code or the invite link holds a learn
 *    session token: kept in sessionStorage (`ss.learn.token`, gone when the
 *    tab closes) and sent as `Authorization: Learn <token>`. No cookie, so
 *    no CSRF surface.
 *  - Someone signed in with an account (the portal sign-in) has no learn
 *    token; their calls go through the portal's `apiFetch`, which carries
 *    the portal bearer and refreshes it. /learn/* accepts either.
 *
 *  A 401 means the session is over either way: the token is dropped and
 *  the page goes back to sign-in. */
import { apiFetch } from '@portal/lib/api';

import { learnApiUrl } from './api';

export const TOKEN_KEY = 'ss.learn.token';

interface Stored { t: string; exp: string; n?: string }

function readStored(): Stored | null {
  let raw: string | null;
  try { raw = sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (typeof stored.t === 'string' && stored.t && !(Date.parse(stored.exp) <= Date.now())) return stored;
  } catch { /* damaged value: treated as signed out */ }
  clearToken();
  return null;
}

export function getToken(): string | null {
  return readStored()?.t ?? null;
}

/** The first name the sign-in answered with, for the greeting. */
export function getFirstName(): string {
  const n = readStored()?.n;
  return typeof n === 'string' ? n : '';
}

export function setToken(t: string, expiresAt: string, firstName?: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(
      { t, exp: expiresAt, ...(firstName ? { n: firstName } : {}) } satisfies Stored));
  } catch { /* storage blocked: the session lasts as long as this page */ }
}

export function clearToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}

// ── going back to sign-in ───────────────────────────────────────────

function goToSignIn(): void {
  if (window.location.pathname !== '/') window.location.assign('/');
}
let signedOutHandler: () => void = goToSignIn;

/** The app installs a router navigation here (a full reload is the
 *  default); returns a function that puts the previous handler back. */
export function setSignedOutHandler(fn: () => void): () => void {
  const previous = signedOutHandler;
  signedOutHandler = fn;
  return () => { signedOutHandler = previous; };
}

function withLearnAuth(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Learn ${token}`);
  return { ...init, headers };
}

export async function learnFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const resp = token
    ? await fetch(`${learnApiUrl()}${path}`, withLearnAuth(init, token))
    : await apiFetch(path, init);
  if (resp.status === 401) {
    clearToken();
    signedOutHandler();
  }
  return resp;
}

/** Ends a learn session (the server revokes it) and forgets the token. An
 *  account session is the portal's to end (AuthContext's logout). */
export async function learnSignOut(): Promise<void> {
  const token = getToken();
  clearToken();
  if (!token) return;
  try {
    await fetch(`${learnApiUrl()}/learn/auth/logout`, withLearnAuth({ method: 'POST' }, token));
  } catch { /* offline: the token is gone here, and it expires on its own */ }
}
