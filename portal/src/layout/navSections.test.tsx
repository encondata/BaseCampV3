import { describe, expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

describe('NAV_SECTIONS', () => {
  it('gives every section a truthy icon', () => {
    for (const section of NAV_SECTIONS) {
      expect(section.icon, `${section.label} is missing an icon`).toBeTruthy();
    }
  });

  it('has unique section labels', () => {
    const labels = NAV_SECTIONS.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
