/** The top-bar tray buttons show a keyboard focus ring, the same one as the
 *  crumbs beside them (jsdom loads no CSS, so this reads the stylesheet). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../styles/kiosk.css', import.meta.url)), 'utf8');

it('the tray buttons have the crumbs\' focus-visible ring', () => {
  const ring = /outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*1px/;
  expect(css).toMatch(new RegExp(String.raw`a\.kiosk-crumb:focus-visible\s*\{[^}]*` + ring.source));
  expect(css).toMatch(new RegExp(String.raw`\.kiosk-sys-btn:focus-visible\s*\{[^}]*` + ring.source));
});
