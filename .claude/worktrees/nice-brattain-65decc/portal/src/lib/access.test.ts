import { describe, expect, it } from 'vitest';

import {
  ACTIONS, ROUTE_RESOURCE, canTouchRank, computeCan,
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
});

describe('route map', () => {
  it('mirrors the api registry', () => {
    expect(ROUTE_RESOURCE['/people/workers']).toBe('workers');
    expect(ROUTE_RESOURCE['/access']).toBe('access');
    expect(ROUTE_RESOURCE['/']).toBe('dashboard');
    expect(ACTIONS).toEqual(['view', 'add', 'change', 'delete']);
  });
});
