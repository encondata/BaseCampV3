/**
 * Who this kiosk is. The serial is generated once and kept in
 * localStorage; the friendly name is what people see on their phone when
 * they link with this kiosk. Storage can be unavailable (private window,
 * blocked site data) — then the identity lives for the page only and
 * `persistent` is false so Settings can warn.
 */

const SERIAL_KEY = 'ss.kiosk.serial';
const NAME_KEY = 'ss.kiosk.name';
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

export function getIdentity(): KioskIdentity {
  let serial = read(SERIAL_KEY);
  let persistent = true;
  if (!serial) {
    serial = memorySerial ?? newSerial();
    memorySerial = serial;
    persistent = write(SERIAL_KEY, serial);
  }
  const stored = read(NAME_KEY)?.trim();
  return { serial, name: stored || defaultName(serial), persistent };
}

/** Trims and stores; false when blank, too long, or storage refuses. */
export function setKioskName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) return false;
  return write(NAME_KEY, trimmed);
}
