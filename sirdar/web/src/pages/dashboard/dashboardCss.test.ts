/** The dashboard's state styling lives in CSS; these pin the rules the components rely on. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./dashboard.css', import.meta.url)), 'utf8');

it('only selection draws the blue edge: the Production card has no stripe of its own', () => {
  expect(css).not.toMatch(/\.sd-env\.is-production[^{]*\{[^}]*border/);
});

it('the idle server box is dimmed', () => {
  expect(css).toMatch(/\.sd-slot\.is-idle[^{]*\{[^}]*(opacity|border-style)/);
});

it('the placeholder middle box and its icon are muted', () => {
  expect(css).toMatch(/\.sd-node\.is-muted[^{]*\{[^}]*border/);
  expect(css).toMatch(/\.sd-node-icon\.is-muted[^{]*\{[^}]*color:\s*var\(--sd-gray-dot\)/);
});

it('a down load balancer and a bad dot are red', () => {
  expect(css).toMatch(/\.sd-node-lb\.is-down[^{]*\{[^}]*var\(--sd-red-text\)/);
  expect(css).toMatch(/\.sd-dot\.is-bad[^{]*\{[^}]*var\(--sd-red-text\)/);
});
