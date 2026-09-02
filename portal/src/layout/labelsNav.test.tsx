// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

it('Labels sits between Stakeholders and Scanning Hardware, gated on labels', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  const idx = labels.indexOf('Labels');
  expect(idx).toBeGreaterThan(labels.indexOf('Stakeholders'));
  expect(idx).toBeLessThan(labels.indexOf('Scanning Hardware'));
  const section = NAV_SECTIONS[idx];
  expect(section.items.map((i) => i.to)).toEqual([
    '/labels/print', '/labels/generate', '/labels/templates',
    '/labels/printers',
  ]);
  expect(new Set(section.items.map((i) => i.resource)))
    .toEqual(new Set(['labels']));
});
