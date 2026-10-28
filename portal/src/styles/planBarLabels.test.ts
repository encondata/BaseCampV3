/**
 * plans.css: under the sheet (Gantt › Below) a task's name sits left of its
 * bar with a halo, so a link running along the row passes under it. The
 * halo is the lane's own color (`--pln-lane-bg`, redefined on a selected
 * lane), not the page surface, so it doesn't smudge a selected row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, 'plans.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return m[2];
  }
  return '';
}

describe('the names’ halo under the sheet', () => {
  it('is the lane’s color: --pln-lane-bg on a lane, redefined on a selected one', () => {
    expect(rule('.pln-lane')).toMatch(/--pln-lane-bg:\s*var\(--surface\)/);
    expect(rule('.pln-lane.on')).toMatch(/--pln-lane-bg:/);
    const shadow = /text-shadow:([^;]+);/.exec(rule('.pln-bar-label'))?.[1] ?? '';
    expect(shadow).toContain('var(--pln-lane-bg)');
    expect(shadow).not.toContain('var(--surface)');
  });
});
