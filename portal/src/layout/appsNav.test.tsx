/** The Apps section's links follow the environment's apps (SS_APPS via
 *  /system/status): an app that is off loses its link; one the status
 *  doesn't mention (not loaded yet, or an older API) keeps it. */
import { expect, it } from 'vitest';

import { isNavItemVisible } from '../lib/godmode';
import { DEFAULT_SYSTEM_STATUS, appOn } from '../lib/systemStatus';
import { NAV_SECTIONS } from './navSections';

const apps = NAV_SECTIONS.find((s) => s.label === 'Apps')!.items;
const item = (label: string) => apps.find((i) => i.label === label)!;
const can = () => true;

it('the Kiosk and Wiki links name their app', () => {
  expect(item('Kiosk').app).toBe('kiosk');
  expect(item('Wiki').app).toBe('wiki');
});

it('an app that is off hides its link; unknown counts as on', () => {
  const off = { ...DEFAULT_SYSTEM_STATUS, apps: { wiki: false, kiosk: true, learn: true } };
  const on = (a: 'wiki' | 'kiosk') => appOn(off, a);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true, on)).toBe(false);
  expect(isNavItemVisible(item('Kiosk'), can, false, 100, true, on)).toBe(true);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true, (a) => appOn(DEFAULT_SYSTEM_STATUS, a))).toBe(true);
  expect(isNavItemVisible(item('Wiki'), can, false, 100, true)).toBe(true);
});

it('appOn: only an explicit false is off', () => {
  expect(appOn(DEFAULT_SYSTEM_STATUS, 'learn')).toBe(true);
  expect(appOn({ ...DEFAULT_SYSTEM_STATUS, apps: { wiki: true, kiosk: false, learn: false } }, 'kiosk')).toBe(false);
});
