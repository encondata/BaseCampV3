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
 * (d) every `mini-row`/`row-main` element's JSX subtree carries at least
 *     one golden cell class (`cell-primary`/`cell-top`/`cell-sub`/`mono`/
 *     `chip`/`dir-avatar`/`data-table`) — catching rows that get the row
 *     primitive but leave their primary text as a bare `<b>`/`<span>`,
 *     which renders at the browser default instead of golden typography
 *     and never scales with `--list-scale`. This is a regex heuristic,
 *     not a real JSX parser: it finds the line whose `className` contains
 *     `mini-row`/`row-main`, then walks forward counting `<tag`/`</tag>`/
 *     `/>` occurrences line-by-line to approximate the element's subtree,
 *     capped at 60 lines. `check: "markup"` allowlist entries are
 *     file-level (any offending line in that file is allowed) since (d)
 *     violations don't have a stable CSS selector to key on.
 *
 * A 6th test keeps listTypography.allow.json honest as migration tasks
 * land: every allowlist entry must still match at least one *raw*
 * violation (computed without consulting the allowlist) in one of (a)/
 * (b)/(c)/(d) — otherwise it's a stale entry for a violation that no
 * longer exists and should be deleted.
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

interface Allow { file: string; selector?: string; reason: string; check?: 'markup'; }
const allow: Allow[] = JSON.parse(
  readFileSync(join(__dirname, 'listTypography.allow.json'), 'utf8'));
const allowed = (file: string, selector?: string) =>
  allow.some((a) => a.check !== 'markup' && a.file === file
    && (a.selector === undefined || a.selector === selector));
/** (d)-only: check:"markup" entries are file-level — no selector to key on. */
const allowedMarkup = (file: string) =>
  allow.some((a) => a.check === 'markup' && a.file === file);

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

/** (d) raw: `mini-row`/`row-main` elements whose JSX subtree carries no
 *  golden cell class, computed WITHOUT consulting the allowlist. Regex
 *  heuristic — see the file header comment for how the subtree is bounded. */
interface MarkupViolation { file: string; line: number; }
const ROW_CLASS = /\b(mini-row|row-main)\b/;
const GOLDEN_CELL_CLASS = /\b(cell-primary|cell-top|cell-sub|mono|chip|dir-avatar|data-table)\b/;
/** The established `row-main` directory-list convention renders each
 *  column through a page-local `<name>CellFor(row, key)` helper (see
 *  components/statusRules/RulesTab.tsx, called out in several pages'
 *  comments as "the freshest full-pattern list") — the helper's own body
 *  (elsewhere in the file) is what actually applies `cell-top`/`mono`/
 *  chip classes, so it's invisible to this line-window heuristic. Treat
 *  a call to such a helper as satisfying (d) too, or nearly every
 *  already-golden row-main list in the app would false-positive. */
const CELL_HELPER_CALL = /\w*[Cc]ellFor\(/;
const CLASS_ATTR = /className="([^"]*)"/g;
const SUBTREE_CAP_LINES = 60;

function rawViolationsD(): MarkupViolation[] {
  const out: MarkupViolation[] = [];
  for (const dir of ['pages', 'components']) {
    for (const file of walk(join(SRC, dir), /\.tsx$/)) {
      const f = rel(file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        CLASS_ATTR.lastIndex = 0;
        let m: RegExpExecArray | null;
        let isRowStart = false;
        while ((m = CLASS_ATTR.exec(lines[i])) !== null) {
          if (ROW_CLASS.test(m[1])) { isRowStart = true; break; }
        }
        if (!isRowStart) continue;

        const end = Math.min(i + SUBTREE_CAP_LINES, lines.length);
        let depth = 0;
        const subtree: string[] = [];
        for (let j = i; j < end; j++) {
          const line = lines[j];
          subtree.push(line);
          const opens = (line.match(/<[a-zA-Z]/g) ?? []).length;
          const selfCloses = (line.match(/\/>/g) ?? []).length;
          const closes = (line.match(/<\//g) ?? []).length;
          depth += opens - selfCloses - closes;
          if (depth <= 0) break;
        }
        const subtreeText = subtree.join('\n');
        if (!GOLDEN_CELL_CLASS.test(subtreeText) && !CELL_HELPER_CALL.test(subtreeText)) {
          out.push({ file: f, line: i + 1 });
        }
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

  it('(d) mini-row/row-main elements carry a golden cell class', () => {
    const bad = rawViolationsD()
      .filter((v) => !allowedMarkup(v.file))
      .map((v) => `${v.file}:${v.line}`);
    expect(bad, `mini-row/row-main element with no golden cell class in its subtree:\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    expect(allow.filter((a) => !a.reason.trim())).toEqual([]);
  });

  it('every allowlist entry still matches a live violation (no stale entries)', () => {
    const violations = [...rawViolationsA(), ...rawViolationsB(), ...rawViolationsC()];
    const violationsD = rawViolationsD();
    const matches = (a: Allow, v: Violation) =>
      a.file === v.file && (a.selector === undefined || a.selector === v.selector);
    const stale = allow.filter((a) => a.check === 'markup'
      ? !violationsD.some((v) => v.file === a.file)
      : !violations.some((v) => matches(a, v)));
    expect(stale, `stale allowlist entries — delete them:\n${snippet(stale)}`).toEqual([]);
  });
});
