/** How other people's cursors and selections are drawn. Their name and
 *  color arrive through awareness, which each browser sets for itself, so
 *  neither is trusted: the color must be a plain `#rrggbb` (Tiptap's
 *  default drawing pastes it into a style attribute, where
 *  "red; background: url(…)" would load anything), and the name is only
 *  ever text. Runs in the browser only (the server never collaborates). */

const FALLBACK = '#667085';

/** `value` when it's a `#rrggbb` color, else a neutral gray. */
export function safeColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : FALLBACK;
}

type User = Record<string, unknown>;

export function renderCursor(user: User): HTMLElement {
  const color = safeColor(user.color);
  const cursor = document.createElement('span');
  cursor.className = 'collaboration-cursor__caret';
  cursor.style.borderColor = color;
  const label = document.createElement('div');
  label.className = 'collaboration-cursor__label';
  label.style.backgroundColor = color;
  label.textContent = typeof user.name === 'string' ? user.name : '';
  cursor.appendChild(label);
  return cursor;
}

export function renderSelection(user: User): { nodeName: string; class: string; style: string } {
  return {
    nodeName: 'span',
    class: 'ProseMirror-yjs-selection',
    style: `background-color: ${safeColor(user.color)}40`,
  };
}
