/** The Devices card shell's button row is pinned to the card bottom, so
 *  rows on side-by-side cards line up (jsdom loads no CSS, so this reads
 *  the stylesheet). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../styles/kiosk.css', import.meta.url)), 'utf8');

it('the actions row is pinned to the card bottom in CSS', () => {
  expect(css).toMatch(/\.device-card\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
  expect(css).toMatch(/\.device-card-actions\s*\{[^}]*margin-top:\s*auto/);
});
