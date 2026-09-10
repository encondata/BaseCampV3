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
 * (d) within each `mini-row`/`row-main` element's JSX subtree, every
 *     element that renders the row's primary text carries its OWN golden
 *     class (or inherits one from an ancestor that does) — not just "some
 *     golden class exists somewhere in the subtree" (that looser check
 *     let a bare-`<b>` name pass as long as a sibling `mono`/`chip`
 *     existed elsewhere in the row; see git history for the finding this
 *     replaced). Two sub-checks, both computed over the same bounded
 *     subtree:
 *       (d1) every `<b` whose own `className` carries none of
 *            `cell-top`/`cell-sub`/`mono`/`chip`/`pn`/`cell-primary`/
 *            `dir-avatar`, and which is not nested inside an element that
 *            does;
 *       (d2) every `<span` with NO `className` attribute at all (string
 *            or expression) that opens directly into text/an expression
 *            — i.e. bare inline text, not a layout wrapper around other
 *            (already-classed) elements — again exempt when nested
 *            inside a golden-classed element.
 *     The ancestor exemption exists because `directory.css` styles a
 *     `<div className="pn"><b>Name</b><span>Sub</span></div>` pair via
 *     the descendant selectors `.pn b`/`.pn span`, and separately styles
 *     e.g. `<div className="cell-top"><b>X</b></div>` by putting
 *     `font-size` directly on `.cell-top` (which a plain `<b>` child then
 *     inherits) — in both shapes the `<b>`/`<span>` legitimately carries
 *     no class of its own because an ancestor already delivers the
 *     golden typography. Dozens of already-correct rows depend on one
 *     shape or the other (row-main lists via `*CellFor(`, mini-row
 *     dashboard rows like `dash-board-row`/`pdash-clock-row` that have no
 *     `*CellFor(` call at all, and static rows like `Printers.tsx`'s
 *     `ZebraTab`). The finding that prompted d1 only named the `.pn`
 *     case; this generalizes to "any golden-classed ancestor" and
 *     applies the same rule to d2, since both shapes are real and both
 *     would otherwise false-positive on already-correct markup with no
 *     `*CellFor(` call to fall back on.
 *
 *     This is still a regex heuristic, not a real JSX parser: it finds
 *     the line whose `className` contains `mini-row`/`row-main`, then
 *     walks forward counting `<tag`/`</tag>`/`/>` occurrences line-by-line
 *     to approximate the element's subtree, capped at 60 lines (same as
 *     before). Within that subtree text it then re-scans with a
 *     tag-shaped regex (`<tag ...>`, `</tag>`, `<tag .../>`, attributes
 *     allowed to span lines) to track a same-depth "am I nested inside a
 *     golden-classed element" stack, and (d2 only) peeks at the text
 *     immediately following a candidate `<span>`'s opening tag up to its
 *     first child tag to tell "wraps bare text" from "wraps elements".
 *     What it catches: the flat "row's name rendered as a bare
 *     `<b>`/`<span>`" bug this task exists to prevent, in both `mini-row`
 *     and `row-main` families. What it does NOT catch: a `<b>` classed
 *     via `className={expr}` or spread props (only a literal
 *     `className="..."` string is recognized for judging golden-ness,
 *     though `className=` in ANY form still counts as "has a class" for
 *     d2's total-absence check and for a `<span>`'s own ancestor-marking);
 *     a golden class that's present but semantically wrong for that
 *     position; a bare-text child of a `<span>` that isn't its *first*
 *     child (d2 only inspects up to the first nested tag); a `>`/`<`
 *     appearing inside a JS expression within a tag's attributes (e.g.
 *     `{a < b}`), or a `<>...</>` fragment, either of which can desync
 *     the ancestor-nesting stack. `check: "markup"` allowlist entries are
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

/** (d) raw: `mini-row`/`row-main` elements whose JSX subtree carries a
 *  bare-`<b>`/bare-`<span>` primary-text violation (d1/d2), computed
 *  WITHOUT consulting the allowlist. Regex heuristic — see the file
 *  header comment for how the subtree is bounded and what d1/d2 check. */
interface MarkupViolation { file: string; line: number; }
const ROW_CLASS = /\b(mini-row|row-main)\b/;
/** The golden classes for a `<b>`'s/ancestor's own className (d1), and
 *  (generalized — see `scanRowSubtree`) for whether an ancestor already
 *  delivers golden typography to a `<b>`/`<span>` by inheritance (d1/d2).
 *  `pn` counts here too: a `<b className="pn">` would be unusual but is
 *  unambiguously intentional. */
const GOLDEN_B_CLASS = /\b(cell-top|cell-sub|mono|chip|pn|cell-primary|dir-avatar)\b/;
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
/** Matches one JSX tag — opening (`<b className="x">`), closing
 *  (`</span>`), or self-closing (`<img />`) — inside the already-bounded
 *  subtree text. `[^<>]*?` allows an attribute list to wrap lines (it
 *  matches newlines) but stops at the first stray `<`/`>`, which is how a
 *  `{a < b}` expression inside a tag's attributes can desync this. */
const TAG_RE = /<(\/?)([A-Za-z][\w.]*)([^<>]*?)(\/?)>/g;

/** (d1)/(d2): scan one row's already-bounded subtree text for a bare
 *  `<b>` (d1) or a totally classless `<span>` that opens directly into
 *  bare text (d2), tracking a same-depth "am I nested inside an element
 *  that already carries a golden class" stack. `directory.css` styles
 *  `.pn b`/`.pn span` (and, separately, `.cell .cell-top`/`.cell
 *  .cell-sub`/etc.) as descendant selectors, so a `<b>`/`<span>` with no
 *  class of its own still gets golden `font-size` by CSS inheritance the
 *  moment ANY ancestor carries a golden class — not just `.pn` (the
 *  finding that prompted d1 named only `.pn`, since that's the common
 *  case, but the same reasoning covers e.g. `<div className="cell-top">
 *  <b>Name</b></div>`, an established pattern too — see
 *  `pages/Printers.tsx`'s `ZebraTab`). Generalizing this exemption keeps
 *  both d1 and d2 from false-positiving on that pattern. Closing tags pop
 *  the stack unconditionally (best-effort; this doesn't verify the tag
 *  name matches, another documented heuristic gap). */
function scanRowSubtree(subtreeText: string, file: string, startLine: number): MarkupViolation[] {
  const out: MarkupViolation[] = [];
  const goldenAncestorStack: boolean[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(subtreeText)) !== null) {
    const [, closing, tagName, attrs, selfClosing] = m;
    if (closing) { goldenAncestorStack.pop(); continue; }

    // `hasClassAttr` only asks whether a `className=` attribute exists at
    // all (string OR expression, e.g. `className={\`chip ${x}\`}`) — d2
    // cares about total absence, not about resolving a dynamic value.
    // `ownClass`/golden-ness (d1) can only be judged from a literal
    // `className="..."` string; a dynamic `<b>` className would read as
    // non-golden here (none exist in the app today).
    const hasClassAttr = /\bclassName=/.test(attrs);
    const classMatch = /className="([^"]*)"/.exec(attrs);
    const ownClass = classMatch ? classMatch[1] : null;
    const insideGoldenAncestor = goldenAncestorStack.some(Boolean);
    const line = startLine + (subtreeText.slice(0, m.index).match(/\n/g) ?? []).length;

    if (tagName === 'b' && !insideGoldenAncestor
        && !(ownClass !== null && GOLDEN_B_CLASS.test(ownClass))) {
      out.push({ file, line });
    } else if (tagName === 'span' && !selfClosing && !insideGoldenAncestor && !hasClassAttr) {
      // A classless `<span>` is only the (d2) bug — bare inline text —
      // if it opens directly into text/an expression. A classless
      // `<span>` that's purely a layout wrapper around already-tagged
      // children (e.g. `<span><b className="cell-top">Name</b>{sub}</span>`)
      // isn't: check only the content up to the first nested tag, so a
      // wrapper reads as empty here even though it has non-text children
      // later in its body (a documented false-negative gap).
      const afterTag = subtreeText.slice(m.index + m[0].length);
      const nextTagAt = afterTag.indexOf('<');
      const immediateContent = nextTagAt === -1 ? afterTag : afterTag.slice(0, nextTagAt);
      if (immediateContent.trim() !== '') out.push({ file, line });
    }

    if (!selfClosing) {
      goldenAncestorStack.push(ownClass !== null && GOLDEN_B_CLASS.test(ownClass));
    }
  }
  return out;
}

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
        if (CELL_HELPER_CALL.test(subtreeText)) continue;
        out.push(...scanRowSubtree(subtreeText, f, i + 1));
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
