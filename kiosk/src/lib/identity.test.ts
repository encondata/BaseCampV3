// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

import { defaultName, getIdentity, setKioskName } from './identity';

beforeEach(() => localStorage.clear());

it('generates a kiosk-web serial once and keeps it', () => {
  const a = getIdentity();
  expect(a.serial).toMatch(/^kiosk-web-[0-9a-f-]{36}$/);
  expect(a.persistent).toBe(true);
  expect(getIdentity().serial).toBe(a.serial);
});

it('defaults the name from the serial tail and accepts a new name', () => {
  const id = getIdentity();
  expect(id.name).toBe(defaultName(id.serial));
  expect(id.name).toMatch(/^Kiosk [0-9A-F]{4}$/);
  expect(setKioskName('  Dock 3 ')).toBe(true);
  expect(getIdentity().name).toBe('Dock 3');
  expect(setKioskName('   ')).toBe(false);
  expect(setKioskName('x'.repeat(81))).toBe(false);
  expect(getIdentity().name).toBe('Dock 3');
});

it('survives a storage that throws', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const id = getIdentity();
  expect(id.serial).toMatch(/^kiosk-web-/);
  expect(id.persistent).toBe(false);
  expect(getIdentity().serial).toBe(id.serial);   // stable within the page
  expect(setKioskName('Dock')).toBe(false);
  setItem.mockRestore();
  getItem.mockRestore();
});
