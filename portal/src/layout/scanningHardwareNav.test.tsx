// @vitest-environment jsdom
/** Scanning Hardware nav-section wiring: section position + resource
 *  gating comes from navSections data, which godmode.test.ts already
 *  validates structurally — this pins the section's item order and the
 *  fact every item is gated on the same resource. Moved out of the
 *  (now-deleted) pages/ScanningHardware.test.tsx once all four device
 *  families had their own real pages. */

import { expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

it('nav section sits between Stakeholders and Admin, gated on scanning_hardware', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  const idx = labels.indexOf('Scanning Hardware');
  expect(idx).toBeGreaterThan(labels.indexOf('Stakeholders'));
  expect(idx).toBeLessThan(labels.indexOf('Admin'));
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual([
    '/hardware/fixed-readers', '/hardware/kiosks', '/hardware/routers',
  ]);
  expect(new Set(section.items.map((i) => i.resource)))
    .toEqual(new Set(['scanning_hardware']));
});
