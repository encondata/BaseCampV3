// @vitest-environment jsdom
/** Placeholder pages: static shells, so the tests pin the copy and the
 *  nav wiring (section position + resource gating comes from
 *  navSections data, which godmode.test.ts already validates
 *  structurally). */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { NAV_SECTIONS } from '../layout/navSections';
import { HandheldReaders, KioskDevices } from './ScanningHardware';

afterEach(cleanup);

const PAGES = [
  [HandheldReaders, 'Handheld Readers', /Zebra \(Android\)/],
  [KioskDevices, 'Kiosk Devices', /iPad/],
] as const;

for (const [Page, title, hint] of PAGES) {
  it(`renders ${title} with title and hint`, () => {
    render(<Page />);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
  });
}

it('nav section sits between Stakeholders and Admin, gated on scanning_hardware', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  const idx = labels.indexOf('Scanning Hardware');
  expect(idx).toBeGreaterThan(labels.indexOf('Stakeholders'));
  expect(idx).toBeLessThan(labels.indexOf('Admin'));
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual([
    '/hardware/handheld-readers', '/hardware/fixed-readers',
    '/hardware/kiosks', '/hardware/routers',
  ]);
  expect(new Set(section.items.map((i) => i.resource)))
    .toEqual(new Set(['scanning_hardware']));
});
