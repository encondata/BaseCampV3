import { expect, it } from 'vitest';

import { SIRDAR_NAV, visibleSections } from './sirdarNav';

it('has Dashboard, Deployments, Administration and System sections', () => {
  expect(SIRDAR_NAV.map((s) => s.label)).toEqual(['Dashboard', 'Deployments', 'Administration', 'System']);
});

it('drops items and empty sections the user cannot view', () => {
  const only = new Set(['dashboard', 'users']);
  const out = visibleSections((r) => only.has(r));
  expect(out.map((s) => s.label)).toEqual(['Dashboard', 'Administration']);
  expect(out[1].items.map((i) => i.label)).toEqual(['Users']);
});
