/** A collapsible section: a one-line summary over any blocks. Stored as
 *  `details` > (`detailsSummary`, `detailsContent`) and rendered as a
 *  native `<details>` element, so a read-only page (and an export) opens
 *  and closes it without script. Whether it's open is not stored — each
 *  reader toggles it for themselves. DOM-free (the server renders it); the
 *  editor adds its toggle as a node view. */
import { Node } from '@tiptap/core';

export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'details' }];
  },

  renderHTML() {
    return ['details', { 'data-details': '' }, 0];
  },
});

export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'summary' }];
  },

  renderHTML() {
    return ['summary', 0];
  },
});

export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-details-content]' }];
  },

  renderHTML() {
    return ['div', { 'data-details-content': '' }, 0];
  },
});
