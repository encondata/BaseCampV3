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

it('shows the Apps › Wiki link only to people with wiki access, and nowhere else', () => {
  const wikis = NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ section: s.label, ...i })))
    .filter((i) => i.label === 'Wiki');
  expect(wikis).toHaveLength(1);
  expect(wikis[0].section).toBe('Apps');
  expect(wikis[0].resource).toBe('wiki');
  expect(wikis[0].href).toBeTruthy();
});

it('every nav item whose path is a prefix of another item matches exactly (no double highlight)', () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);
  for (const item of items) {
    if (item.to === '/') continue;
    const hasChild = items.some((o) => o !== item && o.to.startsWith(`${item.to}/`));
    if (hasChild) expect(item.end, `${item.to} needs end: true`).toBe(true);
  }
});
