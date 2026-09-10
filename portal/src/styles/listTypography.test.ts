/**
 * Guardrail: list typography lives ONLY in directory.css, as tokens.
 * (a) no other stylesheet sets font-size/font-family/font-weight/
 *     line-height/min-height on a list-ish selector;
 * (b) no page/component renders a raw <table> (use <DataTable>);
 * (c) directory.css list rules use var(--list-…) tokens, never literal px,
 *     for those properties.
 * Deliberate exceptions live in listTypography.allow.json with a reason.
 * Violations print a ready-to-paste allowlist snippet — but the fix is
 * almost always to use the tokens/primitives, not to allowlist.
 *
 * Family-prefix rule for (a): a row/list/table selector's CHILD elements
 * (e.g. `.dash-board-name`, `.mdash-wave-label`) often carry their own
 * hardcoded typography but their own class name has no trigger word, so
 * LIST_SELECTOR alone misses them. Per stylesheet we do a two-pass scan:
 * pass 1 collects a "family prefix" from every list-ish selector (one
 * that already matches LIST_SELECTOR) whose class matches
 * `.<prefix>-(row|rows|cell|cells|list|table|grid|feed)` — e.g.
 * `.dash-board-row` → `dash-board`, `.mdash-wave-row` → `mdash-wave`,
 * `.activity-list` → `activity`. Pass 2 then also treats any rule whose
 * selector contains `.<prefix>-` for one of those collected prefixes as
 * list-ish, catching siblings like `.dash-board-name`/`.dash-board-route`
 * and `.activity-changes` (from the `.activity-list` family) even though
 * their own class name has no trigger word. NOTE: `head` is deliberately
 * excluded from this suffix alternation — `.dash-head`/`.access-head`/
 * `.modal-head`-style selectors are common non-list "section heading"
 * names, and including `head` here turned every such prefix (`dash`,
 * `access`, `modal`, …) into a file-wide family, catching unrelated
 * selectors that merely share the prefix.
 *
 * A 5th test keeps listTypography.allow.json honest as migration tasks
 * land: every allowlist entry must still match at least one *raw*
 * violation (computed without consulting the allowlist) in one of (a)/
 * (b)/(c) — otherwise it's a stale entry for a violation that no longer
 * exists and should be deleted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const LIST_SELECTOR = /(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head|\b(?:tr|td|th|thead|tbody)\b)/i;
const TYPO_PROPS = /^(font-size|font-family|font-weight|line-height|min-height)\s*:/;
const DIRECTORY_LIST_RULE = /\.(dir-list|list-head|dir-row|row-main|cell|chip|kv|mini-|data-table)/;
const FAMILY_PREFIX = /\.([a-zA-Z0-9-]+)-(?:row|rows|cell|cells|list|table|grid|feed)\b/g;

/** Pass 1: family prefixes for every list-ish selector in a stylesheet. */
function familyPrefixes(selectors: string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const selector of selectors) {
    if (!LIST_SELECTOR.test(selector)) continue;
    FAMILY_PREFIX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FAMILY_PREFIX.exec(selector)) !== null) prefixes.add(m[1]);
  }
  return prefixes;
}

/** Pass 2: a selector is list-ish if it matches directly, or if it shares
 *  a family prefix with a list-ish sibling in the same stylesheet. */
function isListSelector(selector: string, prefixes: Set<string>): boolean {
  if (LIST_SELECTOR.test(selector)) return true;
  for (const prefix of prefixes) {
    if (selector.includes(`.${prefix}-`)) return true;
  }
  return false;
}

interface Allow { file: string; selector?: string; reason: string; }
const allow: Allow[] = JSON.parse(
  readFileSync(join(__dirname, 'listTypography.allow.json'), 'utf8'));
const allowed = (file: string, selector?: string) =>
  allow.some((a) => a.file === file && (a.selector === undefined || a.selector === selector));

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Flat (selector, declarations[]) pairs; nested @media wrappers are
 *  consumed innermost-first by the regex, leaving empty wrappers. */
function rules(css: string): { selector: string; decls: string[] }[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; decls: string[] }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean);
    out.push({ selector, decls });
  }
  return out;
}

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const snippet = (items: Allow[]) => JSON.stringify(items, null, 2);

/** A violation found by (a)/(b)/(c), independent of the allowlist.
 *  `decl` (c only) carries the offending declaration for messaging. */
interface Violation { file: string; selector?: string; decl?: string; }

/** (a) raw: list-ish selectors with typography props outside
 *  directory.css, computed WITHOUT consulting the allowlist. */
function rawViolationsA(): Violation[] {
  const out: Violation[] = [];
  for (const file of walk(join(SRC, 'styles'), /\.css$/)) {
    const f = rel(file);
    if (f === 'styles/directory.css') continue;
    const parsed = rules(readFileSync(file, 'utf8'));
    const prefixes = familyPrefixes(parsed.map((r) => r.selector));
    for (const r of parsed) {
      if (!isListSelector(r.selector, prefixes)) continue;
      if (!r.decls.some((d) => TYPO_PROPS.test(d))) continue;
      out.push({ file: f, selector: r.selector });
    }
  }
  return out;
}

/** (b) raw: raw <table> usage outside components/DataTable.tsx,
 *  computed WITHOUT consulting the allowlist. */
function rawViolationsB(): Violation[] {
  const out: Violation[] = [];
  for (const dir of ['pages', 'components']) {
    for (const file of walk(join(SRC, dir), /\.tsx$/)) {
      const f = rel(file);
      if (f === 'components/DataTable.tsx') continue;
      if (/<table\b/.test(readFileSync(file, 'utf8'))) out.push({ file: f });
    }
  }
  return out;
}

/** (c) raw: literal px/pt typography in directory.css list rules,
 *  computed WITHOUT consulting the allowlist. */
function rawViolationsC(): Violation[] {
  const out: Violation[] = [];
  for (const r of rules(readFileSync(join(SRC, 'styles/directory.css'), 'utf8'))) {
    if (!DIRECTORY_LIST_RULE.test(r.selector)) continue;
    for (const d of r.decls) {
      if (TYPO_PROPS.test(d) && /\d(px|pt)\b/.test(d) && !/var\(--list-/.test(d)) {
        out.push({ file: 'styles/directory.css', selector: r.selector, decl: d });
      }
    }
  }
  return out;
}

describe('list typography guardrail', () => {
  it('(a) only directory.css sets typography on list-ish selectors', () => {
    const bad: Allow[] = rawViolationsA()
      .filter((v) => !allowed(v.file, v.selector))
      .map((v) => ({ file: v.file, selector: v.selector, reason: '' }));
    expect(bad, `list typography outside directory.css:\n${snippet(bad)}`).toEqual([]);
  });

  it('(b) no raw <table> outside components/DataTable.tsx', () => {
    const bad: Allow[] = rawViolationsB()
      .filter((v) => !allowed(v.file, v.selector))
      .map((v) => ({ file: v.file, reason: '' }));
    expect(bad, `raw <table> (use <DataTable>):\n${snippet(bad)}`).toEqual([]);
  });

  it('(c) directory.css list rules use tokens, not literal px, for typography', () => {
    const bad: string[] = rawViolationsC()
      .filter((v) => !allowed(v.file, v.selector))
      .map((v) => `${v.selector} { ${v.decl} }`);
    expect(bad, `literal sizes in directory.css list rules:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    expect(allow.filter((a) => !a.reason.trim())).toEqual([]);
  });

  it('every allowlist entry still matches a live violation (no stale entries)', () => {
    const violations = [...rawViolationsA(), ...rawViolationsB(), ...rawViolationsC()];
    const matches = (a: Allow, v: Violation) =>
      a.file === v.file && (a.selector === undefined || a.selector === v.selector);
    const stale = allow.filter((a) => !violations.some((v) => matches(a, v)));
    expect(stale, `stale allowlist entries — delete them:\n${snippet(stale)}`).toEqual([]);
  });
});
