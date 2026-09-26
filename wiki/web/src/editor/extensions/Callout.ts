/** A colored box around one or more blocks: info, tip, warning or danger.
 *  DOM-free (the server renders it); the editor adds its variant switcher
 *  as a node view. */
import { Node } from '@tiptap/core';

export const CALLOUT_VARIANTS = ['info', 'tip', 'warning', 'danger'] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

function variantOf(value: unknown): CalloutVariant {
  return CALLOUT_VARIANTS.includes(value as CalloutVariant) ? (value as CalloutVariant) : 'info';
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (el) => variantOf(el.getAttribute('data-callout')),
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-callout': variantOf(node.attrs.variant) }, 0];
  },
});
