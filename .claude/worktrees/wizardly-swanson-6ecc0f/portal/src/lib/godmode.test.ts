import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from '../layout/navSections';
import { isNavItemVisible } from './godmode';

const canAll = () => true;
const canNone = () => false;
const canAllBut = (denied: string) => (resource: string) => resource !== denied;

describe('isNavItemVisible', () => {
  it('shows an ordinary item whenever permission allows, god mode irrelevant', () => {
    const item = { resource: 'sites' };
    expect(isNavItemVisible(item, canAll, false)).toBe(true);
    expect(isNavItemVisible(item, canAll, true)).toBe(true);
    expect(isNavItemVisible(item, canNone, false)).toBe(false);
    expect(isNavItemVisible(item, canNone, true)).toBe(false);
  });

  it('hides a godOnly item until god mode is active', () => {
    const item = { resource: 'devtools', godOnly: true };
    expect(isNavItemVisible(item, canAll, false)).toBe(false);
    expect(isNavItemVisible(item, canAll, true)).toBe(true);
  });

  it('keeps a godOnly item hidden without the permission, even in god mode', () => {
    // god mode reveals; it never grants
    const item = { resource: 'devtools', godOnly: true };
    expect(isNavItemVisible(item, canAllBut('devtools'), true)).toBe(false);
  });
});

describe('NAV_SECTIONS', () => {
  // Asserts against the REAL nav table, not a stand-in. `godOnly: true` on the
  // Variables item is the only thing keeping it out of the sidebar for a
  // developer who has not unlocked god mode — drop the flag and this fails.
  it('hides Variables without god mode even when devtools is held', () => {
    const item = NAV_SECTIONS
      .flatMap((s) => s.items)
      .find((i) => i.to === '/dev/database/variables');

    expect(item, 'no nav item for /dev/database/variables').toBeDefined();
    expect(isNavItemVisible(item!, canAll, false)).toBe(false);
    expect(isNavItemVisible(item!, canAll, true)).toBe(true);
  });
});
