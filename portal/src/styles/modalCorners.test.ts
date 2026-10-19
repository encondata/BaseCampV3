/**
 * Guardrail: a dialog's header and footer never show square corners.
 *
 * `.modal-card` is rounded (16px), but some cards set `overflow: visible`
 * so their dropdowns can escape (e.g. printers.css's zp-align-card). Then
 * the gray `.modal-head` band, and a `.modal-foot` with a background, paint
 * square over the card's rounded corners (Jimmy, 2026-10-19: "another item
 * you consistently miss is non rounded edges on modals"). chrome.css rounds
 * the header's top corners and the footer's bottom corners to the card's
 * inner radius, so every dialog in the portal, kiosk and wiki is covered
 * whatever its overflow.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const chrome = readFileSync(join(__dirname, 'chrome.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const at = chrome.indexOf(selector);
  expect(at, `chrome.css has no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return chrome.slice(at, chrome.indexOf('}', at));
}

it('the dialog header is rounded at the top, the footer at the bottom', () => {
  const head = rule('.modal-card > .modal-head:first-child');
  expect(head).toMatch(/border-top-left-radius:\s*15px/);
  expect(head).toMatch(/border-top-right-radius:\s*15px/);
  const foot = rule('.modal-card > .modal-foot:last-child');
  expect(foot).toMatch(/border-bottom-left-radius:\s*15px/);
  expect(foot).toMatch(/border-bottom-right-radius:\s*15px/);
});

it('the card radius those corners follow is still 16px', () => {
  expect(rule('.modal-card {')).toMatch(/border-radius:\s*16px/);
});
