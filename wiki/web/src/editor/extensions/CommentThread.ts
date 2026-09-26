/** The text a comment thread is anchored to: a mark carrying `threadId`.
 *  It doesn't grow as you type at its edges (`inclusive: false`), and
 *  threads may overlap (`excludes: ''` — y-prosemirror keeps overlapping
 *  marks of one type apart by their attributes). Rendered as a classed
 *  span only, for the light highlight. DOM-free. */
import { Mark } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentThread: {
      /** Anchor thread `threadId` to the current (non-empty) selection. */
      setCommentThread: (threadId: string) => ReturnType;
      /** Remove thread `threadId`'s anchor everywhere in the document
       *  (other threads on the same text stay). */
      unsetCommentThread: (threadId: string) => ReturnType;
    };
  }
}

export const CommentThread = Mark.create({
  name: 'commentThread',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-thread') || null,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-thread]' }];
  },

  renderHTML({ mark }) {
    return ['span', { 'data-comment-thread': mark.attrs.threadId ?? '', class: 'wiki-comment-mark' }, 0];
  },

  addCommands() {
    return {
      setCommentThread: (threadId) => ({ state, tr, dispatch }) => {
        const { empty, ranges } = state.selection;
        if (empty || !threadId) return false;
        if (dispatch) {
          const mark = this.type.create({ threadId });
          ranges.forEach(({ $from, $to }) => { tr.addMark($from.pos, $to.pos, mark); });
        }
        return true;
      },
      unsetCommentThread: (threadId) => ({ state, tr, dispatch }) => {
        let found = false;
        state.doc.descendants((node, pos) => {
          node.marks.forEach((mark) => {
            if (mark.type !== this.type || mark.attrs.threadId !== threadId) return;
            found = true;
            if (dispatch) tr.removeMark(pos, pos + node.nodeSize, mark);
          });
        });
        return found;
      },
    };
  },
});
