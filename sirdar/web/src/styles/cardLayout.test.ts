/** Guardrail: Sirdar's cards and key/value lists never clip a value or
 *  widen the page. jsdom can't lay anything out, so this pins the CSS rules
 *  that make that true (each one was missing when Settings › Integrations
 *  clipped its URLs and emails at 1200px). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const CSS = readFileSync(fileURLToPath(new URL('./sirdar.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations for an exact selector (every rule that lists it, merged). */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, sel, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of body.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
    }
  }
  return out;
}

it('the Integrations cards fill the row, one column on a phone', () => {
  expect(decls('.sirdar-integration-cards')['grid-template-columns'])
    .toBe('repeat(auto-fit, minmax(min(100%, 300px), 1fr))');
});

it('a card in any card grid can shrink to its track', () => {
  expect(decls('.sirdar-cards > *')['min-width']).toBe('0');
  expect(decls('.sirdar-cards')['grid-template-columns']).toMatch(/minmax\(min\(100%, \d+px\), 1fr\)/);
});

it('key/value values get the rest of the row and wrap instead of overflowing', () => {
  expect(decls('.sirdar-kv')['grid-template-columns']).toMatch(/ minmax\(0, 1fr\)$/);
  const cell = decls('.sirdar-kv > *');
  expect(cell['min-width']).toBe('0');
  expect(cell['overflow-wrap']).toBe('anywhere');
  expect(CSS).not.toMatch(/\.sirdar-kv[^{]*\{[^}]*(text-overflow|white-space:\s*nowrap)/);
});

it('card heads, target tops and button rows wrap', () => {
  for (const sel of ['.sirdar-section-head', '.sirdar-target-top', '.sirdar-actions', '.sirdar-target-actions']) {
    expect(decls(sel)['flex-wrap'], sel).toBe('wrap');
  }
  expect(decls('.sirdar-card-head h3')['min-width']).toBe('0');
  expect(decls('.sirdar-card-head .chip')['flex']).toBe('none');
});

it('long text inside a card wraps', () => {
  expect(decls('.sirdar-card')['overflow-wrap']).toBe('anywhere');
});
