// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { deleteCookie, MAX_AGE, readCookie, writeCookie } from './cookies';

function wipe(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

beforeEach(wipe);
afterEach(() => { wipe(); vi.restoreAllMocks(); });

it('writes a value and reads it back', () => {
  expect(writeCookie('ss_kiosk_serial', 'kiosk-web-abc')).toBe(true);
  expect(readCookie('ss_kiosk_serial')).toBe('kiosk-web-abc');
});

it('returns null for a cookie that was never set', () => {
  expect(readCookie('ss_kiosk_nothing')).toBeNull();
});

it('survives the punctuation cookie syntax reserves', () => {
  expect(writeCookie('ss_kiosk_name', 'Dock 3, Bay 2; row=4')).toBe(true);
  expect(readCookie('ss_kiosk_name')).toBe('Dock 3, Bay 2; row=4');
});

it('does not confuse one cookie for another whose name it prefixes', () => {
  writeCookie('ss_kiosk', 'short');
  writeCookie('ss_kiosk_serial', 'long');
  expect(readCookie('ss_kiosk')).toBe('short');
  expect(readCookie('ss_kiosk_serial')).toBe('long');
});

it('asks for a lifetime measured in years, not the session', () => {
  const spy = vi.spyOn(document, 'cookie', 'set');
  writeCookie('ss_kiosk_serial', 'kiosk-web-abc');
  const written = String(spy.mock.calls[0][0]);
  expect(written).toContain(`max-age=${MAX_AGE}`);
  expect(MAX_AGE).toBeGreaterThan(365 * 24 * 60 * 60);
  expect(written).toContain('path=/');
  expect(written).toContain('SameSite=Lax');
});

it('omits Secure over plain http, so local development can write at all', () => {
  const spy = vi.spyOn(document, 'cookie', 'set');
  writeCookie('ss_kiosk_serial', 'kiosk-web-abc');
  expect(String(spy.mock.calls[0][0])).not.toContain('Secure');   // jsdom serves http:
});

it('reports failure when the browser refuses to keep the cookie', () => {
  vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {});
  expect(writeCookie('ss_kiosk_serial', 'kiosk-web-abc')).toBe(false);
});

it('deleteCookie removes the value', () => {
  writeCookie('ss_kiosk_serial', 'kiosk-web-abc');
  deleteCookie('ss_kiosk_serial');
  expect(readCookie('ss_kiosk_serial')).toBeNull();
});
