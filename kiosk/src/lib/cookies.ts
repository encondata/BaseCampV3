/**
 * A cookie, read and written from the page.
 *
 * The kiosk keeps who it is in two places (`lib/identity.ts`), and this
 * is the second one. A cookie is not a better `localStorage`; it is a
 * differently scoped one, and the differences are exactly what the
 * kiosk needs:
 *
 *   - **Ports do not divide it.** `localStorage` is per origin, so
 *     `localhost:5173` and `localhost:5174` are different kiosks that
 *     cannot see each other's serial. Cookies ignore the port, so the
 *     same machine keeps one identity across the dev ports it is served
 *     on.
 *   - **It has a stated lifetime.** A session cookie would be worse
 *     than what we have; `MAX_AGE` asks for ten years, and browsers cap
 *     that themselves (Chrome at 400 days) — which is still far longer
 *     than a move.
 *
 * Everything here fails softly. A browser with cookies disabled simply
 * reads back nothing, and `writeCookie` says so by re-reading rather
 * than trusting the assignment: `document.cookie = …` never throws, it
 * just quietly does nothing.
 *
 * Values are URI-encoded, so a kiosk named "Dock 3, Bay 2" survives the
 * `;`/`,`/`=` that cookie syntax reserves.
 */

/** Ten years. Browsers clamp this down themselves; none of them keep it
 *  shorter than a relocation. */
export const MAX_AGE = 10 * 365 * 24 * 60 * 60;

function canUseCookies(): boolean {
  return typeof document !== 'undefined' && typeof document.cookie === 'string';
}

export function readCookie(name: string): string | null {
  if (!canUseCookies()) return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(';')) {
    const entry = part.trim();
    if (!entry.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(entry.slice(prefix.length));
    } catch {
      return entry.slice(prefix.length);      // not ours, or double-encoded
    }
  }
  return null;
}

/** Writes and confirms by reading back — the only way to know a cookie
 *  landed, since assignment is silent when cookies are blocked. */
export function writeCookie(name: string, value: string, maxAge = MAX_AGE): boolean {
  if (!canUseCookies()) return false;
  const attrs = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'path=/',
    `max-age=${maxAge}`,
    'SameSite=Lax',
  ];
  // Secure would make the cookie unwritable over plain http, which is
  // how the kiosk is served in local development.
  if (typeof location !== 'undefined' && location.protocol === 'https:') attrs.push('Secure');
  try {
    document.cookie = attrs.join('; ');
  } catch {
    return false;
  }
  return readCookie(name) === value;
}

export function deleteCookie(name: string): void {
  if (!canUseCookies()) return;
  try {
    document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    /* nothing to undo */
  }
}
