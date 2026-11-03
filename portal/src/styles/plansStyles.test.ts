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

it('the completion check’s and the delete’s task lists are rounded scroll boxes on theme tokens', () => {
  const chrome = readFileSync(join(__dirname, 'chrome.css'), 'utf8');
  const listed = /:is\(([^)]*)\)::-webkit-scrollbar-track/.exec(chrome)?.[1] ?? '';
  for (const list of ['.pln-done-tasks', '.pln-doomed']) {
    const rule = declarations(list) ?? '';
    expect(rule, list).toMatch(/overflow-y:\s*auto/);
    expect(rule, list).toMatch(/border-radius:\s*\d+px/);
    // colors only from the theme's tokens, so the dark theme has them too
    expect(rule.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), list).toBeNull();
    expect(listed.split(',').map((s) => s.trim()), list).toContain(list);
  }
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

it('a task’s color: its bar, bracket and diamond read --pln-task through the theme’s lift; the critical stripe; gray baselines', () => {
  // the hue as picked on the light theme, lifted on the dark one (as .chip.custom is), its part done a darker shade
  expect(declarations('.pln-tinted')).toMatch(/--pln-hue:\s*oklch\(from var\(--pln-task\)/);
  expect(declarations('.pln-tinted')).toMatch(/--pln-hue-deep:\s*oklch\(from var\(--pln-task\)/);
  // light: capped, as .chip.custom is, so a pale pick (#fff59d) stays visible on a white lane
  expect(declarations('.portal-shell')).toMatch(/--pln-hue-l:\s*min\(l,\s*0\.6\d*\);/);
  expect(declarations('.portal-shell')).toMatch(/--pln-deep-l:\s*calc\(min\(l,\s*0\.6\d*\)\s*\*\s*0\.72\);/);
  expect(declarations('.pln-tinted')).toMatch(/var\(--pln-hue-l,\s*min\(l,\s*0\.6\d*\)\)/);
  expect(declarations(".portal-shell[data-theme='dark']")).toMatch(/--pln-hue-l:\s*clamp\(/);
  expect(declarations('.pln-bar.pln-tinted')).toMatch(/border-color:\s*var\(--pln-hue\)/);
  expect(declarations('.pln-bar.pln-tinted')).toMatch(/background:\s*color-mix\(in srgb, var\(--pln-hue\)/);
  expect(declarations('.pln-tinted .pln-bar-done')).toMatch(/background:\s*var\(--pln-hue-deep\)/);
  expect(declarations('.pln-bar-summary.pln-tinted')).toMatch(/background:\s*var\(--pln-hue\)/);
  expect(allDeclarations('.pln-bar-summary.pln-tinted::before')).toMatch(/border-top-color:\s*var\(--pln-hue\)/);
  expect(declarations('.pln-diamond.pln-tinted')).toMatch(/background:\s*var\(--pln-hue\)/);
  // Critical Path on: the critical red stays, the task's own color a 3px stripe along the top
  const stripe = allDeclarations('.pln-bar-hue');
  expect(stripe).toMatch(/top:\s*0/);
  expect(stripe).toMatch(/height:\s*3px/);
  expect(stripe).toMatch(/background:\s*var\(--pln-hue\)/);
  expect(stripe).toMatch(/pointer-events:\s*none/);
  // baselines stay gray
  expect(allDeclarations('.pln-baseline')).not.toMatch(/--pln-(task|hue)/);
});

it('the today and status-date lines sit behind the lanes and never take the pointer; their marks in the timescale do', () => {
  for (const line of ['.pln-today', '.pln-status-date']) {
    expect(allDeclarations(line)).toMatch(/pointer-events:\s*none/);
    expect(allDeclarations(line)).not.toMatch(/z-index/);
    expect(allDeclarations(`${line}::before`)).toBe('');
  }
  for (const mark of ['.pln-today-mark', '.pln-status-mark']) expect(allDeclarations(mark)).toMatch(/position:\s*absolute/);
});

it('the lanes let the pointer through to the chart; bars, handles and link hit lines take it', () => {
  expect(allDeclarations('.pln-lane')).toMatch(/pointer-events:\s*none/);
  for (const mark of ['.pln-bar', '.pln-bar-summary', '.pln-diamond', '.pln-link-dot']) {
    expect(allDeclarations(mark)).toMatch(/pointer-events:\s*auto/);
  }
  // the link's click target: an invisible line wider than the 1px one
  expect(declarations('.pln-link-hit')).toMatch(/pointer-events:\s*stroke/);
  expect(declarations('.pln-link-hit')).toMatch(/stroke:\s*transparent/);
  expect(Number(/stroke-width:\s*(\d+)/.exec(declarations('.pln-link-hit') ?? '')?.[1])).toBeGreaterThanOrEqual(6);
  // a summary says it can't be dragged
  expect(declarations('.pln-gantt[data-drag="full"] .pln-bar-summary')).toMatch(/cursor:\s*not-allowed/);
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

it('a filter’s context row is dimmed the same in the sheet and the chart; the filter bar’s rules hold no guardrail word', () => {
  const sheet = readFileSync(join(__dirname, 'plan-sheet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sheetRule = /\.pln-row\.pln-context\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? '';
  expect(sheetRule).toMatch(/opacity:\s*0\.55/);
  expect(declarations('.pln-lane.pln-context > *')).toMatch(/opacity:\s*0\.55/);
  // "trigger" holds the guardrail's `tr`: the count and the search are reached without it
  expect(css).not.toMatch(/\.pln-ftools[^{]*tip-trigger/);
});

it('System settings › Project plans: the cards are capped so a control sits near its label, and a line wraps its control under the label when both don’t fit', () => {
  const max = /max-width:\s*(\d+)px/.exec(declarations('.pln-sys') ?? '');
  expect(Number(max?.[1])).toBeGreaterThanOrEqual(880);   // the calendar's week and exceptions need it
  expect(Number(max?.[1])).toBeLessThanOrEqual(1040);
  expect(declarations('.pln-sys-line')).toMatch(/flex-wrap:\s*wrap/);
  // the name gives way (its hint wraps) before the control has to drop under it
  expect(declarations('.pln-sys-line > .set-label')).toMatch(/flex:\s*1 1 \d+px/);
  expect(declarations('.pln-sys-line > .set-label')).toMatch(/min-width:\s*0/);
  // the calendar's five unit fields go three to a line when its card is narrow (their captions stay on one line)
  expect(declarations('.pln-sys-cal')).toMatch(/container-type:\s*inline-size/);
  expect(css).toMatch(/@container\s*\(max-width:\s*\d+px\)\s*\{\s*\.pln-sys-cal \.pln-cal-units\s*\{\s*grid-template-columns:\s*repeat\(3,/);
  // a segmented choice wraps its own buttons on a narrow screen rather than scrolling sideways
  expect(declarations('.pln-set-choice')).toMatch(/flex-wrap:\s*wrap/);
  expect(declarations('.pln-sys-control')).toMatch(/max-width:\s*100%/);
});
