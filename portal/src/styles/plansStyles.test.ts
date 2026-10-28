/**
 * plans.css rules a jsdom render can't show: the Resource Names picker's
 * busy state reads as muted (nothing in it is disabled while a commit is
 * in flight, so focus stays inside), and the toolbar's portaled menus
 * stack above full screen (z 60).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'plans.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list includes `selector`. */
function declarations(selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
  }
  return null;
}

it('the Resource Names picker mutes its waiting buttons and its box while busy', () => {
  expect(declarations('.pln-respick [aria-disabled]')).toMatch(/opacity:\s*0?\.\d+/);
  expect(declarations('.pln-respick[aria-busy]')).toMatch(/cursor:\s*progress/);
  expect(declarations('.pln-respick[aria-busy] > :first-child')).toMatch(/opacity:\s*0?\.\d+/);
});
