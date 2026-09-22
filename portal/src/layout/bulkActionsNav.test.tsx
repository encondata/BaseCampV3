/** Bulk Actions sits directly above Admin and is gated on admin rank. */
import { expect, it, vi } from 'vitest';

import { ADMIN_RANK } from '../lib/access';
import { isNavItemVisible } from '../lib/godmode';
import { NAV_SECTIONS } from './navSections';

it('sits immediately before Admin with one rank-gated item', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  const idx = labels.indexOf('Bulk Actions');
  expect(idx).toBeGreaterThan(labels.indexOf('Scanning Hardware'));
  expect(labels[idx + 1]).toBe('Admin');
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual(['/bulk']);
  expect(section.items[0].minRank).toBe(ADMIN_RANK);
});

it('hides below admin rank and shows at admin rank', () => {
  const item = NAV_SECTIONS.find((s) => s.label === 'Bulk Actions')!.items[0];
  const can = vi.fn(() => true);
  expect(isNavItemVisible(item, can, false, ADMIN_RANK - 1, true)).toBe(false);
  expect(isNavItemVisible(item, can, false, ADMIN_RANK, true)).toBe(true);
});
