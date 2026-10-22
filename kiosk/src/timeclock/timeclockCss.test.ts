/** The time clock stylesheet (jsdom loads no CSS, so this reads it):
 *  always light, a landscape layout chosen by media query, everything
 *  scoped under `.tcx`, and no dashed route line. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../styles/timeclock.css', import.meta.url)), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

it('has a landscape block', () => {
  expect(rules).toMatch(/@media[^{]*orientation:\s*landscape/);
});

it('forces light', () => {
  expect(rules).toMatch(/\.tcx\s*\{[^}]*color-scheme:\s*light/);
});

it('fills the screen', () => {
  expect(rules).toMatch(/\.tcx\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/);
});

it('draws no dashed route line', () => {
  expect(rules).not.toMatch(/stroke-dasharray/);
});

it('scopes every selector under .tcx', () => {
  const selectors = rules
    .replace(/@(media|keyframes|supports)[^{]*\{/g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter((sel) => sel && !/^(from|to|[\d.]+%)$/.test(sel));
  expect(selectors.length).toBeGreaterThan(10);
  for (const group of selectors) {
    for (const sel of group.split(',')) expect(sel.trim()).toMatch(/^\.tcx\b/);
  }
});

it('keyboard keys never shrink below a 56 px touch target', () => {
  const keyRules = [...rules.matchAll(/([^{}]*\.tcx-key[^{}]*)\{([^}]*)\}/g)]
    .map((m) => m[2])
    .filter((body) => /min-height/.test(body));
  expect(keyRules.length).toBeGreaterThan(0);
  for (const body of keyRules) {
    const value = /min-height:\s*([^;]+)/.exec(body)![1].trim();
    const floor = /^clamp\(\s*(\d+(?:\.\d+)?)px/.exec(value)?.[1] ?? /^(\d+(?:\.\d+)?)px$/.exec(value)?.[1];
    expect(Number(floor), value).toBeGreaterThanOrEqual(56);
  }
});
