// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

it('Dashboards › Shipments sits right after Move, gated on trucks', () => {
  const items = NAV_SECTIONS.find((s) => s.label === 'Dashboards')!.items;
  const move = items.findIndex((i) => i.to === '/dashboards/move');
  const shipments = items[move + 1];
  expect([shipments.to, shipments.label, shipments.resource])
    .toEqual(['/dashboards/shipments', 'Shipments', 'trucks']);
  expect(shipments.icon).toBeTruthy();
});

it('the /dashboards/shipments route is wrapped in ProtectedRoute resource="trucks"', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  expect(app).toMatch(
    /path="\/dashboards\/shipments"\s+element=\{\s*<ProtectedRoute resource="trucks"><ShipmentsDashboard \/><\/ProtectedRoute>/);
});
