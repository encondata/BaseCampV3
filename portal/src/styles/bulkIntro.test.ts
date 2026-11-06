/** Guardrail: the three-up intro on the bulk tools stacks to one column
 *  on a phone, so the 180px column floors never force a sideways scroll. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'bulk.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

it('.bulk-intro-3 is one column under 640px', () => {
  const media = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?\})\s*\}/g) ?? [];
  const rule = media.join('\n').match(/\.bulk-intro-3\s*\{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/grid-template-columns:\s*1fr/);
});
