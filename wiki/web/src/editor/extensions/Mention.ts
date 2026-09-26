/** An @mention of a person: `personId` and the `label` (their name when
 *  mentioned). Only people who can view the page are offered, so the
 *  label is fine to store and show; the editor's node view shows the
 *  current name when it knows it. The API reads `personId` for mention
 *  notifications and `@label` for search text
 *  (serversherpa/wiki/content.py). DOM-free. */
import { Node } from '@tiptap/core';

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      personId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-mention') || null,
        rendered: false,
      },
      label: {
        default: '',
        parseHTML: (el) => (el.textContent ?? '').replace(/^@/, ''),
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ node }) {
    const { personId, label } = node.attrs;
    return ['span', { 'data-mention': personId ?? '', class: 'wiki-mention' }, `@${label ?? ''}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label ?? ''}`;
  },
});
