// @vitest-environment jsdom
import '../../testing/pmDom';

import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wikiExtensions } from '../schema';

let editor: Editor;

beforeEach(() => {
  editor = new Editor({ extensions: wikiExtensions(), content: '<p>Check the spare PDU stock.</p>' });
});
afterEach(() => { editor.destroy(); });

/** [text, threadIds] for each text run of the first paragraph. */
const runs = () => (editor.getJSON().content?.[0].content ?? []).map((n: JSONContent) => [
  n.text,
  (n.marks ?? []).filter((m) => m.type === 'commentThread').map((m) => m.attrs?.threadId).sort(),
]);

// "Check the spare PDU stock." — positions count from 1 inside the paragraph
const select = (from: number, to: number) => editor.commands.setTextSelection({ from, to });

describe('commentThread commands', () => {
  it('anchors a thread to the selection, overlapping another thread', () => {
    select(11, 20);                                 // "spare PDU"
    expect(editor.commands.setCommentThread('t-a')).toBe(true);
    select(17, 26);                                 // "PDU stock"
    expect(editor.commands.setCommentThread('t-b')).toBe(true);
    expect(runs()).toEqual([
      ['Check the ', []],
      ['spare ', ['t-a']],
      ['PDU', ['t-a', 't-b']],
      [' stock', ['t-b']],
      ['.', []],
    ]);
  });

  it('anchors a thread to a given range, leaving the selection alone', () => {
    editor.commands.setTextSelection(3);
    expect(editor.commands.setCommentThread('t-a', { from: 11, to: 20 })).toBe(true);
    expect(runs()).toEqual([
      ['Check the ', []],
      ['spare PDU', ['t-a']],
      [' stock.', []],
    ]);
    expect(editor.state.selection.from).toBe(3);
    // an empty or out-of-document range anchors nothing
    expect(editor.commands.setCommentThread('t-b', { from: 5, to: 5 })).toBe(false);
    expect(editor.commands.setCommentThread('t-b', { from: 5, to: 999 })).toBe(false);
  });

  it('does nothing without a selection', () => {
    editor.commands.setTextSelection(5);
    expect(editor.commands.setCommentThread('t-a')).toBe(false);
    expect(runs()).toEqual([['Check the spare PDU stock.', []]]);
  });

  it('removes only the named thread, everywhere it appears', () => {
    select(11, 20);
    editor.commands.setCommentThread('t-a');
    select(17, 26);
    editor.commands.setCommentThread('t-b');
    select(1, 6);                                   // "Check" — the same thread twice
    editor.commands.setCommentThread('t-a');
    editor.commands.setTextSelection(1);

    expect(editor.commands.unsetCommentThread('t-a')).toBe(true);
    expect(runs()).toEqual([
      ['Check the spare ', []],
      ['PDU stock', ['t-b']],
      ['.', []],
    ]);
    expect(editor.commands.unsetCommentThread('t-a')).toBe(false);
  });

  it('does not grow when typing at its end', () => {
    select(11, 16);                                 // "spare"
    editor.commands.setCommentThread('t-a');
    editor.commands.setTextSelection(16);
    editor.commands.insertContent('s');
    expect(runs()).toEqual([
      ['Check the ', []],
      ['spare', ['t-a']],
      ['s PDU stock.', []],
    ]);
  });
});
