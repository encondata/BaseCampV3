/** Guardrail: people see "library" and "libraries", never "space(s)".
 *  The code, the API (/wiki/spaces, space_key) and the database keep the
 *  word "space"; only what a person reads changed. This walks every source
 *  file's string literals, template-literal text and JSX text (comments,
 *  identifiers and types are never looked at) and fails on "space" as a
 *  word. Strings that are code, not copy, don't count: a path or class name
 *  ("/spaces", "wiki-space-card", "space_key") and a lone lowercase token
 *  ("space", a discriminant or a key) — except as a JSX attribute's value,
 *  which is always shown. A lone token computed into copy elsewhere (a
 *  ternary picking 'space' as a noun) can slip past; reviewers still read
 *  for those. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

// "space" as a word of prose: not glued to a path, class name, key or identifier
const SPACE_WORD = /(?<![\w\-/.:#@])spaces?(?![\w\-/])/i;
// a lone lowercase token ("space", "space:") is a value or key in code, not copy
const CODE_TOKEN = /^[a-z_]+:?$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith('._') ? [p] : [];
  });
}

function copyTexts(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    // module specifiers are paths, not copy
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = node.text;
    } else if (ts.isJsxText(node)) {
      text = node.getText();
    }
    // a JSX attribute's string (what="space", label="Space") is always copy
    const inJsxAttribute = !!node.parent && ts.isJsxAttribute(node.parent);
    if (text !== null && (inJsxAttribute || !CODE_TOKEN.test(text.trim())) && SPACE_WORD.test(text)) {
      found.push({ text: text.trim(), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it('the word "space" appears in no user-facing copy (the UI says "library")', () => {
  const offenders = walk(SRC).flatMap((file) => copyTexts(file).map(
    ({ text, line }) => `${relative(SRC, file)}:${line}  ${JSON.stringify(text)}`));
  expect(offenders).toEqual([]);
});

it('the guard itself catches copy and lets code through', () => {
  const flagged = (s: string) => !CODE_TOKEN.test(s.trim()) && SPACE_WORD.test(s);
  expect(flagged('New space')).toBe(true);
  expect(flagged('Choose a space…')).toBe(true);
  expect(flagged('All spaces')).toBe(true);
  expect(flagged(' in this space.')).toBe(true);
  expect(flagged('/spaces')).toBe(false);
  expect(flagged('wiki-space-card')).toBe(false);
  expect(flagged('space_key')).toBe(false);
  expect(flagged('space')).toBe(false);
  expect(flagged('New library')).toBe(false);
});
