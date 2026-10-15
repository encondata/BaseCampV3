import { describe, expect, it } from 'vitest';

import {
  ACTIONS, ROUTE_RESOURCE, canTouchRank, computeCan, grantableRoles,
  rolesPayloadForGlobalChange, type PermMap,
} from './access';

const perms: PermMap = {
  workers: { view: true, add: true, change: true, delete: false },
  access: { view: true, add: false, change: false, delete: false },
};

describe('computeCan', () => {
  it('reads the matrix', () => {
    expect(computeCan(perms, 'workers', 'change')).toBe(true);
    expect(computeCan(perms, 'workers', 'delete')).toBe(false);
  });
  it('defaults false for unknown resource or null perms', () => {
    expect(computeCan(perms, 'devtools', 'view')).toBe(false);
    expect(computeCan(null, 'workers', 'view')).toBe(false);
  });
});

describe('canTouchRank', () => {
  it('strictly below, top rank manages peers', () => {
    expect(canTouchRank(100, 100)).toBe(true);
    expect(canTouchRank(80, 60)).toBe(true);
    expect(canTouchRank(60, 60)).toBe(false);
    expect(canTouchRank(40, 60)).toBe(false);
  });
});

describe('rolesPayloadForGlobalChange', () => {
  const anchors = {
    staff: 'global', admin: 'global', worker: 'self', external: 'self',
    client_viewer: 'client', vendor_admin: 'partner',
  };

  it('replaces the global role, keeps self-anchored, drops org-anchored', () => {
    expect(rolesPayloadForGlobalChange(
      ['staff', 'worker', 'client_viewer'], anchors, 'admin',
    )).toEqual(['admin', 'worker']);
  });

  it('never resends client/partner-anchored names (API 422s on them)', () => {
    const payload = rolesPayloadForGlobalChange(
      ['staff', 'client_viewer', 'vendor_admin'], anchors, 'admin');
    expect(payload).not.toContain('client_viewer');
    expect(payload).not.toContain('vendor_admin');
    expect(payload).toEqual(['admin']);
  });

  it('empty selection clears the global role but keeps self grants', () => {
    expect(rolesPayloadForGlobalChange(
      ['staff', 'worker', 'external', 'client_viewer'], anchors, '',
    )).toEqual(['worker', 'external']);
  });

  it('keeps unknown-anchor names (they exist server-side)', () => {
    expect(rolesPayloadForGlobalChange(
      ['mystery_role', 'staff'], anchors, 'admin',
    )).toEqual(['admin', 'mystery_role']);
  });

  it('takes several global roles (Manage roles) in the order given', () => {
    expect(rolesPayloadForGlobalChange(
      ['worker', 'client_viewer'], anchors, ['admin', 'staff'],
    )).toEqual(['admin', 'staff', 'worker']);
    expect(rolesPayloadForGlobalChange(['client_viewer'], anchors, [])).toEqual([]);
  });
});

describe('grantableRoles', () => {
  const role = (name: string, rank: number, scope_anchor: string) =>
    ({ name, label: name.toUpperCase(), rank, scope_anchor });
  const summary = { roles: [
    role('worker', 10, 'self'), role('client_admin', 20, 'client'), role('admin', 60, 'global'),
    role('staff', 40, 'global'), role('vendor_admin', 20, 'partner'), role('super_admin', 80, 'global'),
    role('external', 5, 'self'),
  ] };

  it('offers global and self roles below the actor, highest rank first', () => {
    expect(grantableRoles(summary, 60).map((r) => r.name))
      .toEqual(['staff', 'worker', 'external']);
  });

  it('top rank may grant everything global/self, never client/partner roles', () => {
    expect(grantableRoles(summary, 100).map((r) => r.name))
      .toEqual(['super_admin', 'admin', 'staff', 'worker', 'external']);
  });
});

describe('route map', () => {
  it('mirrors the api registry', () => {
    expect(ROUTE_RESOURCE['/people/workers']).toBe('workers');
    expect(ROUTE_RESOURCE['/access']).toBe('access');
    expect(ROUTE_RESOURCE['/']).toBe('dashboard');
    expect(ACTIONS).toEqual(['view', 'add', 'change', 'delete']);
  });
});
