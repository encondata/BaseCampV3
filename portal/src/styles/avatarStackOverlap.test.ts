// @vitest-environment jsdom
/**
 * The group avatar stack (components/access/GroupsTab.tsx) overlaps its
 * avatars by 7 px. Avatars with photos sit inside a `span.pp-wrap`
 * (PhotoPreview), so the overlap cannot depend on DOM siblings: every
 * `.av-sm` after the first overlaps, whether it is bare or wrapped, and
 * the first one (bare or the first thing inside a first-child wrapper)
 * does not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'access.css'), 'utf8');

afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

function stack(items: string): HTMLElement {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = `<div class="av-stack">${items}</div>`;
  return document.body.firstElementChild as HTMLElement;
}
const bare = '<span class="av-sm"></span>';
const wrapped = '<span class="pp-wrap"><span class="av-sm"></span></span>';
const more = '<span class="av-sm av-more"></span>';

function margins(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.av-sm'))
    .map((el) => getComputedStyle(el).marginLeft);
}

it('does not use a sibling combinator between avatars', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(stripped).not.toMatch(/\.av-sm\s*\+\s*\.av-sm/);
});

it('an un-wrapped stack looks the same as before: first flush, the rest -7px', () => {
  expect(margins(stack(bare + bare + bare + more)))
    .toEqual(['0px', '-7px', '-7px', '-7px']);
});

it('a fully wrapped stack overlaps identically, including the +N chip', () => {
  expect(margins(stack(wrapped + wrapped + wrapped + more)))
    .toEqual(['0px', '-7px', '-7px', '-7px']);
});

it('a mixed stack (initials bare, photos wrapped) overlaps every avatar after the first', () => {
  expect(margins(stack(bare + wrapped + bare + wrapped + more)))
    .toEqual(['0px', '-7px', '-7px', '-7px', '-7px']);
  expect(margins(stack(wrapped + bare + wrapped)))
    .toEqual(['0px', '-7px', '-7px']);
});

it('avatars outside a stack are untouched', () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = `<div class="mini-row">${wrapped}${bare}</div>`;
  expect(margins(document.body.firstElementChild as HTMLElement)).toEqual(['0', '0']);
});
