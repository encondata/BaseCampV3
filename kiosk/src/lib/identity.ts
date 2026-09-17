/**
 * Who this kiosk is.
 *
 * The serial is generated once and then kept in TWO places — a cookie
 * and `localStorage` — because a kiosk that forgets its serial comes
 * back as a stranger: it gets a new default name, and the portal's
 * Kiosk Devices list grows another row for a machine that was already
 * there (the heartbeat upserts the Device by serial).
 *
 * The cookie is the primary and is read first, because it is scoped the
 * way the kiosk actually moves: cookies ignore the PORT, so a kiosk
 * served at `localhost:5174` today and `localhost:5173` tomorrow is one
 * kiosk, where `localStorage` would call it two. `localStorage` stays
 * as the second copy — it is not sent with requests, it holds more, and
 * it survives some clears the cookie jar does not.
 *
 * Whichever store has a value wins, and the other is filled in from it.
 * That is what carries an existing kiosk across this change: the
 * serial already in `localStorage` is found, copied into the cookie,
 * and the kiosk keeps the name it has always had. Nothing regenerates
 * while either store remembers.
 *
 * Both can be unavailable (a private window, blocked site data) — then
 * the identity lives for the page only and `persistent` is false so
 * Settings can warn.
 */

import { readCookie, writeCookie } from './cookies';

const SERIAL_KEY = 'ss.kiosk.serial';
const NAME_KEY = 'ss.kiosk.name';
/** Cookie names cannot hold the dots the storage keys use. */
const SERIAL_COOKIE = 'ss_kiosk_serial';
const NAME_COOKIE = 'ss_kiosk_name';
export const NAME_MAX = 80;

export interface KioskIdentity {
  serial: string;
  name: string;
  persistent: boolean;
}

let memorySerial: string | null = null;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** A v4 uuid — `crypto.randomUUID` where it exists (every browser the
 *  kiosk targets), a Math.random shim otherwise. Also the outbox's
 *  `client_scan_id` generator. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function newSerial(): string {
  return `kiosk-web-${uuid()}`;
}

export function defaultName(serial: string): string {
  return `Kiosk ${serial.slice(-4).toUpperCase()}`;
}

/** The first store that has a value, trimmed; empty strings count as
 *  absent so a cleared cookie cannot shadow a good stored name. */
function remembered(cookie: string, key: string): string | null {
  return readCookie(cookie)?.trim() || read(key)?.trim() || null;
}

/** Put `value` in both stores, and say whether either one kept it. Used
 *  for a fresh serial AND to mirror a value found in only one store, so
 *  the copies converge on the first load after this change. */
function remember(cookie: string, key: string, value: string): boolean {
  const inCookie = readCookie(cookie) === value || writeCookie(cookie, value);
  const inStorage = read(key) === value || write(key, value);
  return inCookie || inStorage;
}

export function getIdentity(): KioskIdentity {
  const found = remembered(SERIAL_COOKIE, SERIAL_KEY);
  const serial = found ?? memorySerial ?? newSerial();
  if (!found) memorySerial = serial;
  const persistent = remember(SERIAL_COOKIE, SERIAL_KEY, serial);

  const name = remembered(NAME_COOKIE, NAME_KEY);
  if (name) remember(NAME_COOKIE, NAME_KEY, name);
  return { serial, name: name || defaultName(serial), persistent };
}

/** Trims and stores in both places; false when blank, too long, or
 *  neither store would keep it. */
export function setKioskName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) return false;
  return remember(NAME_COOKIE, NAME_KEY, trimmed);
}
