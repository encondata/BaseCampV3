/**
 * Guardrail: a scroll box with rounded corners must keep its scrollbar inside
 * those corners. Chromium doesn't clip a scrollbar to border-radius, so the
 * rounded scroll boxes that live in dialogs share one grouped rule set in
 * styles/chrome.css (the `:is(...)` list on its ::-webkit-scrollbar-track rule).
 *  (a) every CSS rule with `overflow`/`overflow-x`/`overflow-y` set to auto or
 *      scroll AND a non-zero `border-radius` must have each of its selectors
 *      in that list, or in NOT_IN_A_DIALOG below with a reason;
 *  (b) no stale entries: every NOT_IN_A_DIALOG key and every chrome.css list
 *      entry must still match a rounded scroll rule;
 *  (c) the chrome.css track rule keeps its `margin-block`, the part that
 *      stops the bar short of the rounded ends.
 * Limits: only the `border-radius` shorthand, and `overflow` / `overflow-x` /
 * `overflow-y` set to `auto` or `scroll` in the SAME rule, are detected. Not
 * seen: per-corner longhands (`border-top-left-radius`...), `overlay`,
 * declarations split across rules, and inline style props.
 * Scans every .css under portal/src, kiosk/src and wiki/web/src (skipping
 * node_modules), comments stripped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const CHROME = join(__dirname, 'chrome.css');
const SCAN_ROOTS = [
  join(ROOT, 'portal', 'src'),
  join(ROOT, 'kiosk', 'src'),
  join(ROOT, 'wiki', 'web', 'src'),
];

/** Rounded scroll boxes that never appear inside a dialog, with why. */
const NOT_IN_A_DIALOG: Record<string, string> = {
  '.combo-menu': 'dropdown list, not a dialog surface (its menu floats over the page)',
  '.tb-results': 'top bar search results dropdown',
  '.itl-scroll': 'initiatives timeline page',
  '.lbl-code': 'label builder code panel on a page',
  '.sys-log-body': 'process logs page',
  '.wiki-search-menu': 'wiki search dropdown',
};

export interface Rule { selector: string; decls: string[]; }

/** Flat rules; nested @media / @supports wrappers are consumed innermost
 *  first by the regex, so only leaf rules come back. */
export function parseRules(css: string): Rule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    out.push({ selector, decls: m[2].split(';').map((d) => d.trim()).filter(Boolean) });
  }
  return out;
}

/** Split on top-level commas only, so `:is(a, b)` stays whole. */
export function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const declValue = (decls: string[], prop: string): string | undefined => {
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i > 0 && d.slice(0, i).trim().toLowerCase() === prop) return d.slice(i + 1).trim();
  }
  return undefined;
};

export function isRoundedScrollRule(decls: string[]): boolean {
  const scrolls = ['overflow', 'overflow-x', 'overflow-y'].some((p) => {
    const v = declValue(decls, p);
    return v !== undefined && v.split(/\s+/).some((w) => w === 'auto' || w === 'scroll');
  });
  if (!scrolls) return false;
  const radius = declValue(decls, 'border-radius');
  // Not rounded: `0`, `0px`, every corner zero, or a zero `a / b` pair.
  const zero = /^0(px)?(\s*\/?\s*0(px)?)*$/;
  return radius !== undefined && !zero.test(radius.replace(/\s*!important$/, '').trim());
}

/** Selectors (one entry per comma part) of every rounded scroll rule. */
export function roundedScrollSelectors(css: string): string[] {
  return parseRules(css)
    .filter((r) => isRoundedScrollRule(r.decls))
    .flatMap((r) => splitSelectors(r.selector));
}

/** A rule selector is covered by a list entry when it is that entry or the
 *  entry scoped under an ancestor (`.auth-scrim .otp-card` for `.otp-card`). */
export function matchesEntry(selector: string, entry: string): boolean {
  return selector === entry || selector.endsWith(` ${entry}`);
}

function walkCss(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

const TRACK = /^:is\((.*)\)::-webkit-scrollbar-track$/;

/** The dialog scrollbar list and track rule, parsed out of chrome.css. */
function chromeList(): { list: string[]; track: Rule | undefined } {
  const track = parseRules(readFileSync(CHROME, 'utf8')).find((r) => TRACK.test(r.selector));
  const m = track ? TRACK.exec(track.selector) : null;
  return { list: m ? splitSelectors(m[1]) : [], track };
}

describe('rounded scroll boxes: parser', () => {
  it('finds a rounded overflow-y: auto rule', () => {
    expect(roundedScrollSelectors('.a { overflow-y: auto; border-radius: 8px; }')).toEqual(['.a']);
  });
  it('ignores border-radius: 0 and boxes that do not scroll', () => {
    expect(roundedScrollSelectors('.a { overflow: auto; border-radius: 0; }')).toEqual([]);
    expect(roundedScrollSelectors('.a { overflow: auto; border-radius: 0px; }')).toEqual([]);
    expect(roundedScrollSelectors('.a { overflow: auto; border-radius: 0 0 0 0; }')).toEqual([]);
    expect(roundedScrollSelectors('.a { overflow: auto; border-radius: 0px / 0px !important; }')).toEqual([]);
    expect(roundedScrollSelectors('.a { overflow: auto; border-radius: 0 0 8px 0; }')).toEqual(['.a']);
    expect(roundedScrollSelectors('.a { overflow: hidden; border-radius: 8px; }')).toEqual([]);
    expect(roundedScrollSelectors('.a { border-radius: 8px; }')).toEqual([]);
  });
  it('splits comma selectors and normalizes whitespace', () => {
    expect(
      roundedScrollSelectors('.a,\n  .b   pre ,.c { overflow-x: scroll; border-radius: 4px 4px 0 0; }'),
    ).toEqual(['.a', '.b pre', '.c']);
  });
  it('ignores commented-out rules and finds rules inside @media', () => {
    expect(roundedScrollSelectors('/* .a { overflow: auto; border-radius: 8px; } */')).toEqual([]);
    expect(
      roundedScrollSelectors('@media (max-width: 600px) { .m { overflow: auto; border-radius: 8px; } }'),
    ).toEqual(['.m']);
  });
  it('matches an entry bare or scoped under an ancestor, not as a suffix of a name', () => {
    expect(matchesEntry('.otp-card', '.otp-card')).toBe(true);
    expect(matchesEntry('.auth-scrim .otp-card', '.otp-card')).toBe(true);
    expect(matchesEntry('.big-otp-card', '.otp-card')).toBe(false);
    expect(matchesEntry('.otp-card .x', '.otp-card')).toBe(false);
  });
  it('keeps :is(...) whole when splitting', () => {
    expect(splitSelectors(':is(.a, .b) .c, .d')).toEqual([':is(.a, .b) .c', '.d']);
  });
});

describe('rounded scroll boxes: guardrail', () => {
  it('every rounded scroll box is in the dialog scrollbar list or says why not', () => {
    const { list } = chromeList();
    const covered = [...list, ...Object.keys(NOT_IN_A_DIALOG)];
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkCss(root)) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        for (const selector of roundedScrollSelectors(readFileSync(file, 'utf8'))) {
          if (!covered.some((e) => matchesEntry(selector, e))) {
            violations.push(
              `${rel}: ${selector} scrolls inside rounded corners — add it to the dialog scrollbar list in styles/chrome.css, or to NOT_IN_A_DIALOG with a reason`,
            );
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no stale entries in the list or in NOT_IN_A_DIALOG', () => {
    const { list } = chromeList();
    const found = SCAN_ROOTS.flatMap((root) => walkCss(root)).flatMap((f) =>
      roundedScrollSelectors(readFileSync(f, 'utf8')),
    );
    const has = (entry: string) => found.some((s) => matchesEntry(s, entry));
    const stale = [
      ...list.filter((s) => !has(s)).map((s) => `chrome.css list: ${s} no longer matches a rounded scroll rule — remove it`),
      ...Object.keys(NOT_IN_A_DIALOG)
        .filter((s) => !has(s))
        .map((s) => `NOT_IN_A_DIALOG: ${s} no longer matches a rounded scroll rule — remove it`),
    ];
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('the chrome.css track rule keeps margin-block', () => {
    const { list, track } = chromeList();
    expect(list.length, 'chrome.css has no :is(...)::-webkit-scrollbar-track rule').toBeGreaterThan(0);
    expect(declValue(track!.decls, 'margin-block'), 'track rule lacks margin-block').toBeTruthy();
  });
});
