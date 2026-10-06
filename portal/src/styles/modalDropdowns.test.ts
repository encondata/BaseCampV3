/**
 * Guardrail: no clippable popup inside a modal card.
 *
 * Why: `.modal-card` (styles/chrome.css) is `max-height: 88vh;
 * overflow-y: auto`, so it clips any absolutely positioned menu that opens
 * inside it. That clipped Fix make/model's list on 2026-10-06 (fixed in
 * main 955b3022). ComboBox and TagInput now portal their menus to
 * document.body by themselves whenever they sit inside a `.modal-card`
 * (components/useMenuPlacement.ts); this test keeps hand-rolled menus from
 * reintroducing the bug.
 *
 * Rule: in every non-test .tsx under portal/src, a JSX element whose
 * className carries a popup class and that sits lexically inside a JSX
 * element whose className carries `modal-card` (same file) is a violation,
 * unless it sits inside a `createPortal(...)` call (bare or
 * `ReactDOM.createPortal`) within that card.
 *
 * How to satisfy it: use ComboBox (it portals its menu automatically in a
 * dialog), or render the menu through createPortal the way RowActionsMenu
 * and ColumnMenu do. There is no allowlist.
 *
 * Popup classes are derived from every .css file under portal/src/styles, not
 * hand listed: a class qualifies when its name reads as a floating menu
 * (POPUP_NAME) and some rule whose selector's LAST compound includes that
 * class declares `position: absolute`. Heuristics, kept simple on purpose:
 *   - comments are stripped; grouped selectors are split on commas;
 *     compound selectors (`.pop-menu.open`) count each class in the last
 *     compound; a class whose only absolute rule is scoped under another
 *     class (`.tag-input .tag-suggest`) still counts;
 *   - @media/@supports (any block whose body holds further blocks) are
 *     descended into; a rule with nested child rules is treated the same
 *     way, so its own declarations are not read (the portal's CSS does
 *     not use native nesting);
 *   - commas inside `:is(...)`/`:not(...)` would mis-split a selector.
 * className text is every string fragment in the attribute: a string
 * literal, the literal parts of a template literal, and any string inside
 * an expression (`cond ? 'pop-menu open' : ''`, `cx({ 'pop-menu': x })`),
 * split on whitespace and compared as whole class tokens.
 *
 * Known limits:
 *   - Coverage is only as wide as POPUP_NAME. An absolutely positioned
 *     popup whose class name doesn't match it is not checked at all. The
 *     known example is `rack-tooltip` (styles/initiatives.css), a hover
 *     tooltip rendered inside RackViewModal's modal card.
 *   - The scan is lexical, element by element. A component that renders
 *     an in-place popup and is used inside a card is not seen, whether it
 *     lives in another file or in the same file (`<Menu />` inside the
 *     card, defined further down). ComboBox and TagInput cover themselves
 *     by auto-portaling.
 *   - The createPortal exemption covers the whole call subtree and never
 *     looks at the portal target, so `createPortal(menu, cardRef.current)`
 *     (a portal back INTO the card) is exempt too.
 *   - A className held in a variable or built from a substitution
 *     (`pop-${kind}`) is not seen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PORTAL_SRC = join(__dirname, '..');
const STYLES = __dirname;
const POPUP_NAME = /menu|popover|suggest|dropdown|listbox/;
const MODAL_CARD = 'modal-card';
const FIX = 'use ComboBox (it portals its menu automatically in a dialog), '
  + 'or render the menu through createPortal like RowActionsMenu / ColumnMenu';

// ── CSS: derive the popup class set ─────────────────────────────────────

function popupClassesFromCss(css: string): Set<string> {
  const out = new Set<string>();
  const visit = (block: string) => {
    let pos = 0;
    for (;;) {
      const open = block.indexOf('{', pos);
      if (open < 0) return;
      let depth = 1;
      let end = open + 1;
      while (end < block.length && depth > 0) {
        if (block[end] === '{') depth++;
        else if (block[end] === '}') depth--;
        end++;
      }
      // The prelude starts after the previous block; drop any `@import …;`
      // style statements that precede it.
      const prelude = block.slice(pos, open).split(';').pop()!.trim();
      const body = block.slice(open + 1, end - 1);
      pos = end;
      if (prelude.startsWith('@') || body.includes('{')) {
        visit(body);
        continue;
      }
      if (!/(?:^|[;\s])position\s*:\s*absolute\b/.test(body)) continue;
      for (const selector of prelude.split(',')) {
        const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/);
        const last = compounds[compounds.length - 1];
        for (const m of last.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
          if (POPUP_NAME.test(m[1])) out.add(m[1]);
        }
      }
    }
  };
  visit(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return out;
}

// ── TSX: find popups lexically inside a modal card ──────────────────────

function classTokens(el: ts.JsxOpeningLikeElement): string[] {
  const attr = el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'className',
  );
  if (!attr?.initializer) return [];
  const fragments: string[] = [];
  const collect = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    ) {
      fragments.push(node.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(attr.initializer);
  return fragments.flatMap((f) => f.split(/\s+/)).filter(Boolean);
}

function isCreatePortal(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === 'createPortal')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createPortal');
}

function findViolations(source: string, popupClasses: Set<string>, rel = 'fixture.tsx'): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node, inCard: boolean, portaled: boolean) => {
    let card = inCard;
    let portal = portaled || isCreatePortal(node);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement : node;
      const classes = classTokens(tag);
      if (card && !portal) {
        const line = sf.getLineAndCharacterOfPosition(tag.getStart(sf)).line + 1;
        for (const c of classes.filter((x) => popupClasses.has(x))) {
          out.push(`${rel}:${line}: ${c} inside .modal-card can be clipped — ${FIX}`);
        }
      }
      // A card (even one that is itself portaled) starts a fresh clipping box.
      if (classes.includes(MODAL_CARD)) {
        card = true;
        portal = false;
      }
    }
    ts.forEachChild(node, (child) => visit(child, card, portal));
  };
  visit(sf, false, false);
  return out;
}

// ── real tree ───────────────────────────────────────────────────────────

function* walk(dir: string, ext: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function realPopupClasses(): Set<string> {
  const all = new Set<string>();
  for (const file of walk(STYLES, /\.css$/)) {
    for (const c of popupClassesFromCss(readFileSync(file, 'utf8'))) all.add(c);
  }
  return all;
}

// ── tests ───────────────────────────────────────────────────────────────

const POPUPS = new Set(['pop-menu', 'combo-menu']);

describe('modal dropdowns guardrail — scanner fixtures', () => {
  it('flags an in-place pop-menu inside a modal card', () => {
    const src = [
      'export function M() {',
      '  return (',
      '    <div className="modal-scrim">',
      '      <div className="modal-card modal-card-wide">',
      '        <div className="pop-wrap">',
      '          <div className="pop-menu">x</div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const out = findViolations(src, POPUPS, 'portal/src/pages/M.tsx');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^portal\/src\/pages\/M\.tsx:6: pop-menu inside \.modal-card can be clipped — /);
  });

  it('ignores a pop-menu outside the modal card', () => {
    const src = [
      'export function M() {',
      '  return (',
      '    <>',
      '      <div className="pop-menu">x</div>',
      '      <div className="modal-card"><p>hi</p></div>',
      '    </>',
      '  );',
      '}',
    ].join('\n');
    expect(findViolations(src, POPUPS)).toEqual([]);
  });

  it('ignores a pop-menu rendered through createPortal inside the card', () => {
    const src = [
      "import { createPortal } from 'react-dom';",
      'export function M({ open }: { open: boolean }) {',
      '  return (',
      '    <div className="modal-card">',
      '      {open && createPortal(<div className="pop-menu">x</div>, document.body)}',
      '      {open && ReactDOM.createPortal(<ul className="combo-menu" />, document.body)}',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    expect(findViolations(src, POPUPS)).toEqual([]);
  });

  it('catches a template-literal className and string parts of an expression', () => {
    const src = [
      'export function M({ up, open }: { up: boolean; open: boolean }) {',
      '  return (',
      '    <div className={`modal-card ${up ? "x" : ""}`}>',
      '      <ul className={`combo-menu ${up ? "up" : ""}`} />',
      "      <div className={open ? 'pop-menu open' : 'closed'} />",
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const out = findViolations(src, POPUPS, 'f.tsx');
    expect(out).toEqual([
      expect.stringMatching(/^f\.tsx:4: combo-menu inside \.modal-card/),
      expect.stringMatching(/^f\.tsx:5: pop-menu inside \.modal-card/),
    ]);
  });

  it('still flags an in-place menu inside a card that is itself portaled', () => {
    const src = [
      "import { createPortal } from 'react-dom';",
      'export function M() {',
      '  return createPortal(',
      '    <div className="modal-scrim">',
      '      <div className="modal-card">',
      '        <div className="pop-menu">x</div>',
      '      </div>',
      '    </div>,',
      '    document.body,',
      '  );',
      '}',
    ].join('\n');
    const out = findViolations(src, POPUPS, 'f.tsx');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^f\.tsx:6: pop-menu inside \.modal-card can be clipped/);
  });

  it('matches whole class tokens only', () => {
    const src = '<div className="modal-card"><div className="pop-menu-ai-title" /><div className="combo-menu-row" /></div>;';
    expect(findViolations(src, POPUPS)).toEqual([]);
  });
});

describe('modal dropdowns guardrail — CSS derivation', () => {
  it('keeps menu-like classes whose rule is position: absolute', () => {
    const css = `
      /* .commented-menu { position: absolute; } */
      .pop-wrap { position: relative; }
      .pop-menu { position: absolute; top: 0; }
      .kbar-menu, .other-dropdown { z-index: 3; position:absolute }
      .tag-input .tag-suggest { position: absolute; }
      .pop-menu.colmenu-portaled { position: fixed; }
      .static-menu { position: relative; }
      .menu-btn:hover > .icon { position: absolute; }
      .not-floating { position: absolute; }
      @media (max-width: 600px) {
        .narrow-popover { position: absolute; }
      }
    `;
    expect([...popupClassesFromCss(css)].sort()).toEqual(
      ['kbar-menu', 'narrow-popover', 'other-dropdown', 'pop-menu', 'tag-suggest'],
    );
  });

  it('derives combo-menu and pop-menu from the real stylesheets', () => {
    const classes = realPopupClasses();
    expect(classes.has('combo-menu'), [...classes].join(', ')).toBe(true);
    expect(classes.has('pop-menu'), [...classes].join(', ')).toBe(true);
  });
});

describe('modal dropdowns guardrail — real tree', () => {
  it('no popup class renders in place inside a .modal-card', () => {
    const popups = realPopupClasses();
    const violations: string[] = [];
    for (const file of walk(PORTAL_SRC, /\.tsx$/)) {
      const rel = `portal/src/${relative(PORTAL_SRC, file)}`;
      violations.push(...findViolations(readFileSync(file, 'utf8'), popups, rel));
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
