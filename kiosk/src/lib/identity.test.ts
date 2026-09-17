// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readCookie, writeCookie } from './cookies';
import { defaultName, getIdentity, setKioskName } from './identity';

function wipeCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

/** localStorage that is there but refuses — a private window, or site
 *  data blocked for this origin. */
function blockStorage(): void {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
}

function blockCookies(): void {
  vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {});
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
}

beforeEach(() => { localStorage.clear(); wipeCookies(); });
afterEach(() => { vi.restoreAllMocks(); wipeCookies(); });

it('generates a kiosk-web serial once and keeps it', () => {
  const a = getIdentity();
  expect(a.serial).toMatch(/^kiosk-web-[0-9a-f-]{36}$/);
  expect(a.persistent).toBe(true);
  expect(getIdentity().serial).toBe(a.serial);
});

it('writes the serial to both the cookie and localStorage', () => {
  const { serial } = getIdentity();
  expect(readCookie('ss_kiosk_serial')).toBe(serial);
  expect(localStorage.getItem('ss.kiosk.serial')).toBe(serial);
});

it('defaults the name from the serial tail and accepts a new name', () => {
  const id = getIdentity();
  expect(id.name).toBe(defaultName(id.serial));
  expect(id.name).toMatch(/^Kiosk [0-9A-F]{4}$/);
  expect(setKioskName('  Dock 3 ')).toBe(true);
  expect(getIdentity().name).toBe('Dock 3');
  expect(readCookie('ss_kiosk_name')).toBe('Dock 3');
  expect(setKioskName('   ')).toBe(false);
  expect(setKioskName('x'.repeat(81))).toBe(false);
  expect(getIdentity().name).toBe('Dock 3');
});

it('keeps the serial a kiosk already had, and copies it into the cookie', () => {
  // The state of every kiosk in the field before cookies existed.
  localStorage.setItem('ss.kiosk.serial', 'kiosk-web-11111111-2222-4333-8444-555555555555');
  localStorage.setItem('ss.kiosk.name', 'Dock 3');

  const id = getIdentity();
  expect(id.serial).toBe('kiosk-web-11111111-2222-4333-8444-555555555555');
  expect(id.name).toBe('Dock 3');                       // not renamed
  expect(readCookie('ss_kiosk_serial')).toBe(id.serial);  // now mirrored
  expect(readCookie('ss_kiosk_name')).toBe('Dock 3');
});

it('keeps the serial when only the cookie survives — the port changed, or storage was cleared', () => {
  writeCookie('ss_kiosk_serial', 'kiosk-web-99999999-8888-4777-8666-555555555555');
  writeCookie('ss_kiosk_name', 'Cage 2');

  const id = getIdentity();
  expect(id.serial).toBe('kiosk-web-99999999-8888-4777-8666-555555555555');
  expect(id.name).toBe('Cage 2');
  expect(localStorage.getItem('ss.kiosk.serial')).toBe(id.serial);   // refilled
});

it('the cookie alone is enough when localStorage refuses', () => {
  const first = getIdentity().serial;
  blockStorage();
  const id = getIdentity();
  expect(id.serial).toBe(first);       // the cookie still knows
  expect(id.persistent).toBe(true);
  expect(setKioskName('Dock 7')).toBe(true);
  expect(getIdentity().name).toBe('Dock 7');
});

it('localStorage alone is enough when cookies are blocked', () => {
  const first = getIdentity().serial;
  blockCookies();
  const id = getIdentity();
  expect(id.serial).toBe(first);
  expect(id.persistent).toBe(true);
});

it('survives both stores failing, and says the identity is not persistent', () => {
  blockStorage();
  blockCookies();
  const id = getIdentity();
  expect(id.serial).toMatch(/^kiosk-web-/);
  expect(id.persistent).toBe(false);
  expect(getIdentity().serial).toBe(id.serial);   // stable within the page
  expect(setKioskName('Dock')).toBe(false);
});
