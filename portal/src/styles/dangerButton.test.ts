/**
 * Guardrail: a destructive solid button is red whatever order the
 * stylesheets load in.
 *
 * `.btn-solid` (profile.css) paints the accent fill with a one-class
 * selector, and `.btn-danger` (directory.css) used to repaint it red with
 * one class too, so the winner was whichever sheet loaded last. The
 * production bundle happened to put directory.css second, but a page whose
 * first import was directory.css (the label templates list, then its
 * dialogs pulling in profile.css) showed an amber Delete. directory.css
 * now also matches `.btn-solid.btn-danger`, which outranks `.btn-solid` on
 * specificity alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const directory = strip(readFileSync(join(__dirname, 'directory.css'), 'utf8'));
const profile = strip(readFileSync(join(__dirname, 'profile.css'), 'utf8'));

/** The declarations of the first rule whose selector list includes `selector`. */
function declarations(css: string, selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return m[2];
  }
  return null;
}

it('the danger fill is set by a two-class .btn-solid.btn-danger rule', () => {
  const rule = declarations(directory, '.btn-solid.btn-danger');
  expect(rule, 'directory.css has no .btn-solid.btn-danger rule').not.toBeNull();
  expect(rule).toMatch(/background:\s*var\(--c-red/);
  expect(rule).toMatch(/color:\s*#fff/);
});

it('the accent fill it overrides is still a one-class .btn-solid rule', () => {
  const rule = declarations(profile, '.btn-solid');
  expect(rule, 'profile.css has no .btn-solid rule').not.toBeNull();
  expect(rule).toMatch(/background:/);
});
