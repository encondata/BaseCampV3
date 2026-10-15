/**
 * Guardrail: every Leaflet map keeps its layers inside itself.
 *
 * Why: Leaflet gives its panes and controls z-index 400–1000. Without a
 * stacking context around the map they paint over anything outside it —
 * the truck detail page's Trail map drew over the Edit truck dialog on
 * 2026-10-15. Each map used to rely on its own wrapper (.trucks-map-panel,
 * .sites-map…) for `isolation: isolate`; one wrapper was missing. The rule
 * now lives once on `.leaflet-container` in styles/chrome.css (loaded by
 * the app shell), so every map — current and future — is covered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const CHROME = readFileSync(join(__dirname, 'chrome.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

it('chrome.css isolates every .leaflet-container', () => {
  const rule = CHROME.match(/(^|\})\s*\.leaflet-container\s*\{([^}]*)\}/);
  expect(rule, '.leaflet-container rule missing from chrome.css').not.toBeNull();
  expect(rule![2]).toMatch(/isolation\s*:\s*isolate\s*;?/);
});
