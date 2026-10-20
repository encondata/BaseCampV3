/**
 * The full-screen takeovers' shared stack (the Asset Not Part Of Move
 * alarm, the label regeneration screen): the newest open one sits on top,
 * answers the keyboard, and everything outside it is `inert`.
 */

/** Open takeovers' root elements, oldest first. Only the last one (on top)
 *  answers the keyboard, and everything outside it is inert. */
export const openTakeovers: HTMLElement[] = [];
/** The elements this module made inert (never one someone else did). */
const madeInert = new Set<Element>();

/** Marks every element outside the top takeover (each sibling of it and
 *  of its ancestors) inert, so Tab, Enter and Escape can't reach the page
 *  underneath; with none open, undoes exactly what it set. */
export function syncInert(): void {
  madeInert.forEach((el) => el.removeAttribute('inert'));
  madeInert.clear();
  const top = openTakeovers[openTakeovers.length - 1];
  if (!top) return;
  for (let node: Element = top; node.parentElement && node !== document.body;
    node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      madeInert.add(sibling);
    }
  }
}
