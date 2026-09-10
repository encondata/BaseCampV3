/**
 * Guardrail: list typography lives ONLY in directory.css, as tokens.
 * (a) no other stylesheet — anywhere under src/, not just styles/ — sets
 *     font-size/font-family/font-weight/line-height/min-height (or the
 *     `font` shorthand, `font: inherit` exempted) on a list-ish selector;
 * (b) no .tsx under pages/, components/, lib/, or layout/ (other than
 *     components/DataTable.tsx) renders a raw <table> (use <DataTable>);
 * (c) directory.css list rules use var(--list-…) tokens, never literal px,
 *     for those properties;
 * (e) no .tsx under pages/, components/, lib/, or layout/ sets
 *     fontSize/fontFamily/fontWeight/lineHeight inline via `style={{…}}`
 *     — the same loophole as (a)/(c) but through React's style prop
 *     instead of a stylesheet rule.
 * (f) no element's className carries BOTH `cell-sub` and `mono` — the one
 *     semantic rule above `.mini-row` in directory.css says prose
 *     (cell-sub) and identifiers (mono) are never the same element.
 * (g) no page stylesheet rule whose selector is a known mini-row/
 *     mini-list-head co-class (any class that co-occurs with either
 *     primitive in a .tsx className string) declares display/padding
 *     (or a padding-* side)/gap/row-gap/column-gap/border (or a
 *     border-* side)/min-height — per spec a page sets
 *     `grid-template-columns` (and colors/widths) on a mini-row/
 *     mini-list-head and nothing else; the box model itself is the
 *     primitive's alone, so a page rule that restates it (in full or by
 *     one side/axis) only wins by import order, not intent.
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
 * `check: "inline"` allowlist entries key on `file` + `selector`, where
 * `selector` is the offending line's own text, trimmed and capped at 200
 * chars — (e) violations, unlike (a)/(b)/(c), don't have a CSS selector,
 * but unlike (d) they DO have a stable single-line text to key on, so
 * they get their own line-level granularity instead of (d)'s file-level
 * one. The key is the WHOLE line (not a short prefix) so two violations
 * on lines that merely start the same way — e.g. two `style={{ fontSize:
 * 12, ...}}` blocks that diverge only after the first 40 characters —
 * get distinct entries instead of silently sharing one.
 * `check: "dualclass"` ((f)) is keyed the same way "inline" used to be —
 * a className violation has a stable single-line text, not a CSS
 * selector, but (f)'s hint is still the first 40 trimmed chars of the
 * line (dualclass violations are short `className="..."` fragments where
 * a 40-char prefix reliably disambiguates, unlike (e)'s often-long
 * `style={{...}}` lines).
 * `check: "coclass"` ((g)) is keyed like (a)/(c)'s plain entries (file +
 * the CSS rule's own selector), since a (g) violation IS a CSS rule.
 *
 * A test keeps listTypography.allow.json honest as migration tasks land:
 * every allowlist entry must still match at least one *raw* violation
 * (computed without consulting the allowlist) in one of (a)/(b)/(c)/(d)/
 * (e)/(f)/(g) — otherwise it's a stale entry for a violation that no
 * longer exists and should be deleted.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const LIST_SELECTOR = /(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head|\b(?:tr|td|th|thead|tbody)\b)/i;
/** `font` shorthand counts too (a bare `font: 700 14px/1.4 sans-serif`
 *  is just as much a typography-outside-directory.css bug as the
 *  longhand props) — except `font: inherit`, the common "don't apply my
 *  own type scale, use the ancestor's" reset used on button/label chrome,
 *  which sets no size/family/weight/line-height of its own to leak. */
const TYPO_PROPS = /^(?:(?:font-size|font-family|font-weight|line-height|min-height)\s*:|font\s*:(?!\s*inherit\s*$))/;
const DIRECTORY_LIST_RULE = /\.(dir-list|list-head|dir-row|row-main|cell|chip|kv|mini-|data-table)/;
const FAMILY_PREFIX = /\.([a-zA-Z0-9-]+)-(?:row|rows|cell|cells|list|table|grid|feed)\b/g;
/** (e)-only: an inline `style={{…}}` setting one of these props is the
 *  same loophole as (a)/(c) through React's style prop instead of a
 *  stylesheet rule. `font` shorthand isn't included here — no inline
 *  `style={{ font: … }}` exists in the app today, and unlike the CSS
 *  case there's no established `font: inherit` idiom to exempt. */
const INLINE_FONT_PROP = /\b(fontSize|fontFamily|fontWeight|lineHeight)\s*:/;

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

interface Allow {
  file: string; selector?: string; reason: string;
  check?: 'markup' | 'inline' | 'dualclass' | 'coclass';
}
const allow: Allow[] = JSON.parse(
  readFileSync(join(__dirname, 'listTypography.allow.json'), 'utf8'));
const allowed = (file: string, selector?: string) =>
  allow.some((a) => a.check === undefined && a.file === file
    && (a.selector === undefined || a.selector === selector));
/** (d)-only: check:"markup" entries are file-level — no selector to key on. */
const allowedMarkup = (file: string) =>
  allow.some((a) => a.check === 'markup' && a.file === file);
/** (e)-only: check:"inline" entries key on file + the offending line's own
 *  text (the `selector` field doubles as a line-text hint here). */
const allowedInline = (file: string, hint: string) =>
  allow.some((a) => a.check === 'inline' && a.file === file && a.selector === hint);
/** (f)-only: check:"dualclass" entries key on file + the offending line's
 *  own text, same shape as (e)'s "inline". */
const allowedDualClass = (file: string, hint: string) =>
  allow.some((a) => a.check === 'dualclass' && a.file === file && a.selector === hint);
/** (g)-only: check:"coclass" entries key on file + the CSS rule's own
 *  selector text, same shape as (a)/(c)'s plain entries. */
const allowedCoClass = (file: string, selector: string) =>
  allow.some((a) => a.check === 'coclass' && a.file === file && a.selector === selector);

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
 *  directory.css, computed WITHOUT consulting the allowlist. Walks every
 *  `.css` under src/, not just styles/ — the rule is "typography lives in
 *  directory.css", not "typography lives in the styles/ folder". */
function rawViolationsA(): Violation[] {
  const out: Violation[] = [];
  for (const file of walk(SRC, /\.css$/)) {
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

/** Directories that can carry app .tsx: page/component markup, plus
 *  lib/ and layout/ (shared helpers and the app shell/nav) — both can
 *  render a <table> or an inline style just as easily as a page can.
 *  Guarded with existsSync since not every checkout necessarily has all
 *  four (today's does). */
const TSX_DIRS = ['pages', 'components', 'lib', 'layout'];

/** (b) raw: raw <table> usage outside components/DataTable.tsx,
 *  computed WITHOUT consulting the allowlist. */
function rawViolationsB(): Violation[] {
  const out: Violation[] = [];
  for (const dir of TSX_DIRS) {
    const base = join(SRC, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, /\.tsx$/)) {
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
/** `session-item` (profile.css) is a fourth row family — the sessions/
 *  certs/org-contact/external-link rows — that isn't `mini-row`/
 *  `row-main` under the hood (it's a plain flex row, not the mini-row
 *  grid, so renaming it would be more than a class swap) but follows the
 *  exact same "primary text needs a golden cell class" contract, so (d)
 *  scans it too. */
const ROW_CLASS = /\b(mini-row|row-main|session-item)\b/;
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

/** (e) raw: inline `style={{…}}` carrying fontSize/fontFamily/fontWeight/
 *  lineHeight in a pages/components/lib/layout .tsx file, computed
 *  WITHOUT consulting the allowlist. Same idea as (a) but for React's
 *  style prop instead of a stylesheet rule — a hardcoded inline size is
 *  just as much a leak of list typography (or a duplicate of it) as a
 *  hand-rolled CSS rule would be. One violation per `style={{…}}` block
 *  (not per offending prop inside it — two font props on one line would
 *  otherwise report as identical duplicate entries), keyed on the line
 *  where the FIRST matching prop appears (which, for a multi-line style
 *  object, is often a few lines below the `style={{` itself). */
interface InlineViolation { file: string; line: number; hint: string; }
const STYLE_BLOCK = /style=\{\{([\s\S]*?)\}\}/g;
function rawViolationsE(): InlineViolation[] {
  const out: InlineViolation[] = [];
  for (const dir of TSX_DIRS) {
    const base = join(SRC, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, /\.tsx$/)) {
      const f = rel(file);
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      STYLE_BLOCK.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = STYLE_BLOCK.exec(src)) !== null) {
        const body = sm[1];
        const pm = INLINE_FONT_PROP.exec(body);
        if (!pm) continue;
        const bodyStart = sm.index + sm[0].indexOf(body);
        const absoluteIndex = bodyStart + pm.index;
        const line = (src.slice(0, absoluteIndex).match(/\n/g) ?? []).length + 1;
        out.push({ file: f, line, hint: lines[line - 1].trim().slice(0, 200) });
      }
    }
  }
  return out;
}

/** (f) raw: an element whose `className` carries BOTH `cell-sub` and
 *  `mono` — the one semantic rule above `.mini-row` in directory.css
 *  says prose (`cell-sub`) and identifiers (`mono`) are never the same
 *  element. Cheap regex over a literal `className="..."` string, same
 *  spirit (and the same acknowledged gap — a dynamic `className={...}`
 *  combining both isn't caught) as (a)/(c)/(d)'s `ownClass` check. */
interface DualClassViolation { file: string; line: number; hint: string; }
function rawViolationsF(): DualClassViolation[] {
  const out: DualClassViolation[] = [];
  for (const dir of TSX_DIRS) {
    const base = join(SRC, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, /\.tsx$/)) {
      const f = rel(file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        CLASS_ATTR.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CLASS_ATTR.exec(line)) !== null) {
          if (/\bcell-sub\b/.test(m[1]) && /\bmono\b/.test(m[1])) {
            out.push({ file: f, line: i + 1, hint: line.trim().slice(0, 40) });
          }
        }
      });
    }
  }
  return out;
}

/** (g): every class token that co-occurs with `mini-row` OR `mini-list-head`
 *  in some .tsx `className` string (a literal string, or a backtick
 *  template's static parts with `${…}` expressions blanked out) — these
 *  page "co-classes" ride along on one of the two mini-list primitives
 *  and, per finding #6, can silently fight the primitive's own box model
 *  if their own CSS rule restates display/padding/gap/border/min-height
 *  (only winning by import order). Both primitives are scanned together
 *  (rather than as two separate passes) because a page's section-header
 *  row co-classes `mini-list-head` the exact same way a data row
 *  co-classes `mini-row`, and the box-model properties being guarded are
 *  the same set either primitive owns. Cheap regex, not a real JSX
 *  parser — same spirit as the rest of this file; a co-class applied
 *  only via a fully dynamic `className={expr}` (no literal
 *  "mini-row"/"mini-list-head" text anywhere) isn't found, the same
 *  acknowledged gap as (d)'s `ownClass`. */
const CLASSNAME_ATTR_RE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
const MINI_LIST_PRIMITIVES = ['mini-row', 'mini-list-head'];
function deriveMiniRowCoClasses(): Set<string> {
  const co = new Set<string>();
  for (const dir of TSX_DIRS) {
    const base = join(SRC, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base, /\.tsx$/)) {
      const src = readFileSync(file, 'utf8');
      CLASSNAME_ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLASSNAME_ATTR_RE.exec(src)) !== null) {
        const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
        const tokens = raw.split(/\s+/).filter(Boolean);
        if (!tokens.some((t) => MINI_LIST_PRIMITIVES.includes(t))) continue;
        for (const t of tokens) if (!MINI_LIST_PRIMITIVES.includes(t)) co.add(t);
      }
    }
  }
  return co;
}

/** Same disallowed set finding #6 names for a co-class rule: the
 *  box-model properties `.mini-row`/`.mini-list-head` (directory.css)
 *  already own. Widened from an exact-name match to also catch the
 *  longhand/logical siblings of each shorthand — `padding-left` etc.,
 *  `row-gap`/`column-gap` alongside `gap`, `border-top`/`border-left`/
 *  etc. alongside `border`/`border-bottom` — since a page rule that
 *  restates just one side of the box model fights the primitive exactly
 *  as much as restating the shorthand does. */
const COCLASS_BAD_PROPS =
  /^(?:display|padding(?:-[a-z]+)?|gap|row-gap|column-gap|border(?:-[a-z]+)?|min-height)\s*:/;

/** (g) raw: a page stylesheet rule whose selector contains a known
 *  mini-row/mini-list-head co-class declaring one of the properties
 *  above, computed WITHOUT consulting the allowlist. `directory.css`
 *  (the primitives themselves) is exempt. The co-class is matched as a
 *  real CSS class token (`.token` not immediately followed by another
 *  identifier character) so `.dash-board-row` doesn't also match
 *  `.dash-board-route`. */
interface CoClassViolation { file: string; selector: string; decl: string; }
function rawViolationsG(): CoClassViolation[] {
  const coClasses = deriveMiniRowCoClasses();
  const out: CoClassViolation[] = [];
  for (const file of walk(SRC, /\.css$/)) {
    const f = rel(file);
    if (f === 'styles/directory.css') continue;
    const parsed = rules(readFileSync(file, 'utf8'));
    for (const r of parsed) {
      const isCoClassRule = [...coClasses].some((token) => {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\.${escaped}(?![\\w-])`).test(r.selector);
      });
      if (!isCoClassRule) continue;
      for (const d of r.decls) {
        if (COCLASS_BAD_PROPS.test(d)) out.push({ file: f, selector: r.selector, decl: d });
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

  it('(e) no inline fontSize/fontFamily/fontWeight/lineHeight in pages/components/lib/layout', () => {
    const bad: Allow[] = rawViolationsE()
      .filter((v) => !allowedInline(v.file, v.hint))
      .map((v) => ({ file: v.file, selector: v.hint, reason: '' }));
    expect(bad, `inline list typography (use CSS classes/tokens):\n${snippet(bad)}`).toEqual([]);
  });

  it('(f) an element never combines cell-sub with mono', () => {
    const bad: Allow[] = rawViolationsF()
      .filter((v) => !allowedDualClass(v.file, v.hint))
      .map((v) => ({ file: v.file, selector: v.hint, reason: '' }));
    expect(bad, `className carries both cell-sub and mono (pick one):\n${snippet(bad)}`).toEqual([]);
  });

  it('(g) a mini-row/mini-list-head co-class in page CSS is layout-only (grid-template-columns + colors/widths)', () => {
    const bad: Allow[] = rawViolationsG()
      .filter((v) => !allowedCoClass(v.file, v.selector))
      .map((v) => ({ file: v.file, selector: v.selector, reason: '' }));
    expect(bad, `mini-row co-class restates the primitive's own box model:\n${snippet(bad)}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    expect(allow.filter((a) => !a.reason.trim())).toEqual([]);
  });

  it('every allowlist entry still matches a live violation (no stale entries)', () => {
    const violations = [...rawViolationsA(), ...rawViolationsB(), ...rawViolationsC()];
    const violationsD = rawViolationsD();
    const violationsE = rawViolationsE();
    const violationsF = rawViolationsF();
    const violationsG = rawViolationsG();
    const matches = (a: Allow, v: Violation) =>
      a.file === v.file && (a.selector === undefined || a.selector === v.selector);
    const stale = allow.filter((a) => {
      if (a.check === 'markup') return !violationsD.some((v) => v.file === a.file);
      if (a.check === 'inline') return !violationsE.some((v) => v.file === a.file && v.hint === a.selector);
      if (a.check === 'dualclass') return !violationsF.some((v) => v.file === a.file && v.hint === a.selector);
      if (a.check === 'coclass') return !violationsG.some((v) => v.file === a.file && v.selector === a.selector);
      return !violations.some((v) => matches(a, v));
    });
    expect(stale, `stale allowlist entries — delete them:\n${snippet(stale)}`).toEqual([]);
  });
});
