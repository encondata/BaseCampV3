import type { KeyboardEvent } from 'react';

/** Roving-tabindex arrow-key movement inside a radiogroup. */
export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!dir) return;
  const group = e.currentTarget.closest('[role="radiogroup"]');
  const items = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])') ?? []);
  const next = items[(items.indexOf(e.currentTarget) + dir + items.length) % items.length];
  if (next) { e.preventDefault(); next.focus(); next.click(); }
}
