/** System › Blocked addresses sits directly after Access control and is
 *  gated on admin rank (SS-487). */
import { expect, it, vi } from 'vitest';

import { ADMIN_RANK } from '../lib/access';
import { isNavItemVisible } from '../lib/godmode';
import { NAV_SECTIONS } from './navSections';

const system = () => NAV_SECTIONS.find((s) => s.label === 'System')!;

it('sits directly after Access control in System', () => {
  const tos = system().items.map((i) => i.to);
  expect(tos[tos.indexOf('/access') + 1]).toBe('/system/blocked-addresses');
  const item = system().items.find((i) => i.to === '/system/blocked-addresses')!;
  expect(item.label).toBe('Blocked addresses');
  expect(item.resource).toBe('dashboard');
  expect(item.minRank).toBe(ADMIN_RANK);
  expect(item.icon).toBeTruthy();
});

it('shows to rank 60 and hides from rank 40', () => {
  const item = system().items.find((i) => i.to === '/system/blocked-addresses')!;
  const can = vi.fn(() => true);
  expect(isNavItemVisible(item, can, false, 40, true)).toBe(false);
  expect(isNavItemVisible(item, can, false, 60, true)).toBe(true);
});
