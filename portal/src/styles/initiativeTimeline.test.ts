/**
 * initiative-timeline.css (Initiatives › Timeline): a track with no bar in
 * range (`.itl-row-bars.noted`) shows its note at the top, the plan's
 * milestone diamonds below the note, and the real-dates bar (actual start
 * to finish, or to today) below the diamonds, so none sits on another.
 * The page sets no type of its own: the ruler, the band and the note take
 * directory.css's golden classes inside a `.cell`, whose rules draw their
 * sizes from the `--list-fs-*` tokens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TIMELINE = strip(readFileSync(join(__dirname, 'initiative-timeline.css'), 'utf8'));
const DIRECTORY = strip(readFileSync(join(__dirname, 'directory.css'), 'utf8'));

/** The declarations of every rule whose selector list names `selector`. */
function rule(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out.join('\n');
}

/** A px property of `selector`, the last rule naming it winning. */
function px(selector: string, prop: string): number | undefined {
  const found = [...rule(TIMELINE, selector).matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)px`, 'g'))];
  return found.length ? Number(found[found.length - 1][1]) : undefined;
}

describe('a noted track', () => {
  const track = px('.itl-row-bars', 'height')!;
  const size = px('.itl-milestone', 'height')!;
  const diamondTop = px('.itl-row-bars.noted .itl-milestone', 'top')!;
  const barTop = px('.itl-row-bars.noted .itl-real-bar', 'top') ?? px('.itl-real-bar', 'top')!;
  const barHeight = px('.itl-real-bar', 'height')!;
  // a square turned 45°: its corners reach half a diagonal from its center
  const reach = (size * Math.SQRT2) / 2;
  const diamond = [diamondTop + size / 2 - reach, diamondTop + size / 2 + reach];

  it('reads its sizes from the stylesheet', () => {
    expect([track, size, diamondTop, barTop, barHeight].every(Number.isFinite)).toBe(true);
  });

  it('keeps the milestone diamonds off the real-dates bar', () => {
    expect(diamond[1]).toBeLessThan(barTop);
  });

  it('keeps the real-dates bar inside the track', () => {
    expect(barTop + barHeight).toBeLessThanOrEqual(track);
  });

  it('moves nothing on a track with a bar: the real-dates bar stays under it', () => {
    expect(px('.itl-real-bar', 'top')).toBe(34);
    expect(px('.itl-milestone', 'top')).toBe(15);
  });
});

describe('the type the page borrows', () => {
  it.each([
    ['.cell .mono', '--list-fs-mono'],
    ['.cell .cell-top', '--list-fs-cell'],
    ['.cell .cell-sub', '--list-fs-sub'],
  ])('%s is sized by %s', (selector, token) => {
    expect(rule(DIRECTORY, selector)).toMatch(new RegExp(`font-size:\\s*var\\(${token}\\)`));
  });

  it('the timeline stylesheet sets no type of its own', () => {
    expect(TIMELINE).not.toMatch(/font-(?:size|family|weight)\s*:|line-height\s*:/);
  });
});
