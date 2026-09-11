import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from '../layout/navSections';
import { isNavItemVisible } from './godmode';

const canAll = () => true;
const canNone = () => false;
const canAllBut = (denied: string) => (resource: string) => resource !== denied;

describe('isNavItemVisible', () => {
  it('shows an ordinary item whenever permission allows, god mode irrelevant', () => {
    const item = { resource: 'sites' };
    expect(isNavItemVisible(item, canAll, false, 0, true)).toBe(true);
    expect(isNavItemVisible(item, canAll, true, 0, true)).toBe(true);
    expect(isNavItemVisible(item, canNone, false, 0, true)).toBe(false);
    expect(isNavItemVisible(item, canNone, true, 0, true)).toBe(false);
  });

  it('hides a godOnly item until god mode is active', () => {
    const item = { resource: 'devtools', godOnly: true };
    expect(isNavItemVisible(item, canAll, false, 0, true)).toBe(false);
    expect(isNavItemVisible(item, canAll, true, 0, true)).toBe(true);
  });

  it('keeps a godOnly item hidden without the permission, even in god mode', () => {
    // god mode reveals; it never grants
    const item = { resource: 'devtools', godOnly: true };
    expect(isNavItemVisible(item, canAllBut('devtools'), true, 0, true)).toBe(false);
  });

  it('globalOnly items hide for non-global users', () => {
    const item = { to: '/x', label: 'X', resource: 'dashboard', icon: null,
                   globalOnly: true };
    const canAll = () => true;
    expect(isNavItemVisible(item, canAll, false, 100, true)).toBe(true);
    expect(isNavItemVisible(item, canAll, false, 100, false)).toBe(false);
    const plain = { ...item, globalOnly: undefined };
    expect(isNavItemVisible(plain, canAll, false, 100, false)).toBe(true);
  });
});

describe('minRank gating', () => {
  const yes = () => true;
  it('hides items below the rank floor', () => {
    const item = { resource: 'dashboard', minRank: 80 };
    expect(isNavItemVisible(item, yes, false, 60, true)).toBe(false);
    expect(isNavItemVisible(item, yes, false, 80, true)).toBe(true);
  });
  it('items without minRank ignore rank', () => {
    expect(isNavItemVisible({ resource: 'dashboard' }, yes, false, 0, true))
      .toBe(true);
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
    expect(isNavItemVisible(item!, canAll, false, 0, true)).toBe(false);
    expect(isNavItemVisible(item!, canAll, true, 0, true)).toBe(true);
  });

  it('registers Dashboards above Assets and Admin above System', () => {
    const labels = NAV_SECTIONS.map((s) => s.label);
    expect(labels.indexOf('Dashboards')).toBe(0);
    expect(labels.indexOf('Dashboards')).toBeLessThan(labels.indexOf('Assets'));
    expect(labels.indexOf('Admin')).toBeGreaterThan(labels.indexOf('Stakeholders'));
    expect(labels.indexOf('Admin')).toBeLessThan(labels.indexOf('System'));

    const assets = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.to === '/assets');
    expect(assets, 'no nav item for /assets').toBeDefined();
    expect(assets!.resource).toBe('assets');
    expect(isNavItemVisible(assets!, canAllBut('assets'), false, 0, true)).toBe(false);
    expect(isNavItemVisible(assets!, canAll, false, 0, true)).toBe(true);

    const models = NAV_SECTIONS.flatMap((s) => s.items)
      .find((i) => i.to === '/assets/models');
    expect(models, 'no nav item for /assets/models').toBeDefined();
    expect(models!.resource).toBe('asset_models');
    expect(isNavItemVisible(models!, canAllBut('asset_models'), false, 0, true)).toBe(false);

    // Makes / Models lives under Assets (moved out of Admin 2026-09-10);
    // Admin is still exactly one section holding the Audit log.
    const assetsSection = NAV_SECTIONS.find((s) => s.label === 'Assets');
    expect(assetsSection?.items.map((i) => i.to)).toContain('/assets/models');
    const adminSections = NAV_SECTIONS.filter((s) => s.label === 'Admin');
    expect(adminSections).toHaveLength(1);
    const adminItems = adminSections[0].items.map((i) => i.to);
    expect(adminItems).not.toContain('/assets/models');
    expect(adminItems).toContain('/admin/audit');
  });
});
