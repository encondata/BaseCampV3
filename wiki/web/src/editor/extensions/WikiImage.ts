/** An image stored as a page asset. The document holds only the asset id
 *  (never a URL — presigned URLs expire); the editor and the read-only
 *  view resolve it when they render. DOM-free: the node view with resize
 *  handles is added in the editor. */
import { Node } from '@tiptap/core';

function widthOf(value: string | null): number | null {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const WikiImage = Node.create({
  name: 'wikiImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-wiki-image') || null,
        rendered: false,
      },
      alt: {
        default: '',
        parseHTML: (el) => el.querySelector('img')?.getAttribute('alt') ?? '',
        rendered: false,
      },
      caption: {
        default: '',
        parseHTML: (el) => el.querySelector('figcaption')?.textContent ?? '',
        rendered: false,
      },
      width: {
        default: null,
        parseHTML: (el) => widthOf(el.getAttribute('data-width')),
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-wiki-image]' }];
  },

  renderHTML({ node }) {
    const { assetId, alt, caption, width } = node.attrs;
    return [
      'figure',
      { 'data-wiki-image': assetId ?? '', ...(width ? { 'data-width': String(width) } : {}) },
      ['img', { alt: alt ?? '' }],
      ...(caption ? [['figcaption', {}, caption]] : []),
    ];
  },
});
