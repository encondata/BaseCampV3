/** Guardrail: the print CSS that keeps a no-print page from printing (see
 *  PrintGuard) is still in wiki.css — hide everything under <body> when it
 *  prints, except the notice. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./wiki.css', import.meta.url)), 'utf8');

it('hides the page when printing with body[data-no-print], except the notice', () => {
  const print = css.slice(css.indexOf('@media print'));
  expect(print).toMatch(/body\[data-no-print\]\s*>\s*\*\s*\{[^}]*display:\s*none\s*!important/);
  expect(print).toMatch(/body\[data-no-print\]\s+\.wiki-print-blocked\s*\{[^}]*display:\s*block\s*!important/);
});

it('keeps the notice off the screen', () => {
  expect(css).toMatch(/\.wiki-print-blocked\s*\{\s*display:\s*none;\s*\}/);
});

it('drops an embedded file whose own printing is off, from a page that prints', () => {
  const print = css.slice(css.indexOf('@media print'));
  expect(print).toMatch(/\[data-print-off\]\s*\{[^}]*display:\s*none\s*!important/);
});
