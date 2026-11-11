import { expect, it } from 'vitest';

import { SIRDAR_NAV, visibleSections } from './sirdarNav';

it('has Dashboard, Deployments, Seed Data, Administration and System sections', () => {
  expect(SIRDAR_NAV.map((s) => s.label)).toEqual(['Dashboard', 'Deployments', 'Seed Data', 'Administration', 'System']);
});

it('Seed Data holds DB and Spaces under the seed_data resource', () => {
  const seed = SIRDAR_NAV.find((s) => s.label === 'Seed Data')!;
  expect(seed.items.map((i) => [i.label, i.to, i.resource])).toEqual([
    ['DB', '/seed/db', 'seed_data'], ['Spaces', '/seed/spaces', 'seed_data'],
  ]);
});

it('drops items and empty sections the user cannot view', () => {
  const only = new Set(['dashboard', 'users']);
  const out = visibleSections((r) => only.has(r));
  expect(out.map((s) => s.label)).toEqual(['Dashboard', 'Administration']);
  expect(out[1].items.map((i) => i.label)).toEqual(['Users']);
});

it('Deployments holds Environments at /deploy, gated on deploy', () => {
  const deploy = SIRDAR_NAV.find((s) => s.label === 'Deployments')!;
  expect(deploy.items.map((i) => [i.label, i.to, i.resource])).toEqual([['Environments', '/deploy', 'deploy']]);
});
