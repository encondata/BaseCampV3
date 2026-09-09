// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

it('Reports sits right after Labels, one item gated on reports', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  expect(labels.indexOf('Reports')).toBe(labels.indexOf('Labels') + 1);
  const section = NAV_SECTIONS[labels.indexOf('Reports')];
  expect(section.items.map((i) => [i.to, i.label, i.resource])).toEqual([
    ['/reports', 'Reports', 'reports'],
  ]);
});
