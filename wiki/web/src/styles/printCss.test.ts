/** Guardrail: the print CSS that keeps a no-print page from printing (see
 *  PrintGuard) is still in wiki.css — hide everything under <body> when it
 *  prints, except the notice. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./wiki.css', import.meta.url)), 'utf8');

/** The inside of the `@media print { … }` block, found by matching braces
 *  (so a rule elsewhere in the file can't satisfy these checks). */
function printBlock(source: string): string {
  const start = source.indexOf('@media print');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced @media print block');
}

it('hides the page when printing with body[data-no-print], except the notice', () => {
  const print = printBlock(css);
  expect(print).toMatch(/body\[data-no-print\]\s*>\s*\*\s*\{[^}]*display:\s*none\s*!important/);
  expect(print).toMatch(/body\[data-no-print\]\s+\.wiki-print-blocked\s*\{[^}]*display:\s*block\s*!important/);
});

it('keeps the notice off the screen', () => {
  expect(css).toMatch(/\.wiki-print-blocked\s*\{\s*display:\s*none;\s*\}/);
});

it('drops an embedded file whose own printing is off, from a page that prints', () => {
  const print = printBlock(css);
  expect(print).toMatch(/\[data-print-off\]\s*\{[^}]*display:\s*none\s*!important/);
});

it('finds the print block by its matching brace, not by where the next rule starts', () => {
  const sample = '.a { color: red; } @media print { .b { x: 1; } .c { y: 2; } } .d { z: 3; }';
  const inside = printBlock(sample);
  expect(inside).toContain('.b { x: 1; }');
  expect(inside).toContain('.c { y: 2; }');
  expect(inside).not.toContain('.d');
  expect(inside).not.toContain('.a');
});
