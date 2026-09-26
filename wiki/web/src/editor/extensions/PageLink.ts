/** An inline link to another wiki node. `title` is the target's title when
 *  the link was made; the editor's node view shows the live title (or
 *  "Missing page"). DOM-free. */
import { Node } from '@tiptap/core';

export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      nodeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-link') || null,
        rendered: false,
      },
      title: {
        default: '',
        parseHTML: (el) => el.textContent ?? '',
        rendered: false,
      },
    };
  },

  parseHTML() {
    // ahead of the Link mark's `a[href]` rule, which would otherwise claim it
    return [{ tag: 'a[data-page-link]', priority: 1100 }];
  },

  renderHTML({ node }) {
    const { nodeId, title } = node.attrs;
    const href = `/n/${encodeURIComponent(nodeId ?? '')}`;
    return ['a', { 'data-page-link': nodeId ?? '', href }, title ?? ''];
  },

  renderText({ node }) {
    return node.attrs.title ?? '';
  },
});
