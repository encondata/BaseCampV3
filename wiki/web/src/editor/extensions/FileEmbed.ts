/** A card for a wiki file node (`nodeId`) or a page asset (`assetId`).
 *  DOM-free: the editor's node view adds the inline PDF/image/video preview. */
import { Node } from '@tiptap/core';

export const FileEmbed = Node.create({
  name: 'fileEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      nodeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-node-id') || null,
        rendered: false,
      },
      assetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-asset-id') || null,
        rendered: false,
      },
      filename: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-filename') ?? '',
        rendered: false,
      },
      contentType: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-content-type') ?? '',
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-embed]' }];
  },

  renderHTML({ node }) {
    const { nodeId, assetId, filename, contentType } = node.attrs;
    return [
      'div',
      {
        'data-file-embed': '',
        ...(nodeId ? { 'data-node-id': nodeId } : {}),
        ...(assetId ? { 'data-asset-id': assetId } : {}),
        'data-filename': filename ?? '',
        'data-content-type': contentType ?? '',
      },
      filename ?? '',
    ];
  },
});
