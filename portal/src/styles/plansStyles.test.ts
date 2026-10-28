/**
 * plans.css rules a jsdom render can't show: the Resource Names picker's
 * busy state reads as muted (nothing in it is disabled while a commit is
 * in flight, so focus stays inside), and the toolbar's off buttons look
 * off without being `disabled` (they keep their tooltip and arrow-key stop).
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

/** The declarations of every rule whose selector list includes `selector`. */
function allDeclarations(selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .map((m) => m[2]).join(';');
}

it('the Resource Names picker mutes its waiting buttons and its box while busy', () => {
  expect(declarations('.pln-respick [aria-disabled]')).toMatch(/opacity:\s*0?\.\d+/);
  expect(declarations('.pln-respick[aria-busy]')).toMatch(/cursor:\s*progress/);
  expect(declarations('.pln-respick[aria-busy] > :first-child')).toMatch(/opacity:\s*0?\.\d+/);
});

it('an aria-disabled toolbar button is muted and doesn’t light up on hover', () => {
  expect(declarations('.mini-btn.pln-tbtn[aria-disabled]')).toMatch(/opacity:\s*0?\.\d+/);
  expect(declarations('.mini-btn.pln-tbtn[aria-disabled]:hover')).toMatch(/background:\s*transparent/);
});

it('the Gantt colors critical work with --c-red, deadlines with --c-green, and bars with the accent', () => {
  expect(declarations('.pln-bar')).toMatch(/var\(--accent\)/);
  expect(declarations('.pln-bar.pln-bar-critical')).toMatch(/var\(--c-red\)/);
  expect(declarations('.pln-bar.pln-bar-critical .pln-bar-done')).toMatch(/var\(--c-red\)/);
  expect(declarations('.pln-diamond.pln-diamond-critical')).toMatch(/var\(--c-red\)/);
  expect(declarations('.pln-link-path.pln-link-critical')).toMatch(/var\(--c-red\)/);
  expect(declarations('.pln-deadline')).toMatch(/color:\s*var\(--c-green\)/);
});

it('the panes scroll up and down in one box, each sideways on its own, headers held at the top', () => {
  // one vertical box that never scrolls sideways
  expect(declarations('.pln-panes')).toMatch(/overflow-x:\s*hidden/);
  expect(declarations('.pln-panes')).toMatch(/overflow-y:\s*auto/);
  // a pane clips without becoming a scroll box (which would catch the sticky header)
  expect(declarations('.pln-pane')).toMatch(/overflow-x:\s*clip/);
  expect(declarations('.pln-pane')).not.toMatch(/overflow(-y)?:\s*(auto|scroll|hidden)/);
  // its scrollbar held at the bottom of the view; the timescale at the top, as tall as the sheet's header
  expect(allDeclarations('.pln-hbar')).toMatch(/position:\s*sticky/);
  expect(allDeclarations('.pln-hbar')).toMatch(/bottom:\s*0/);
  expect(declarations('.pln-scale')).toMatch(/position:\s*sticky/);
  expect(declarations('.pln-scale')).toMatch(/height:\s*var\(--pln-head-h\)/);
});
