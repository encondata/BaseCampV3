// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wikiExtensions } from './schema';
import { findTrigger, SLASH_PATTERN, useTrigger } from './suggest';

let editor: Editor;
let renders = 0;

function Probe() {
  useTrigger(editor, (state) => findTrigger(state, SLASH_PATTERN, { wholeBlock: true }));
  renders += 1;
  return null;
}

beforeEach(() => {
  editor = new Editor({ extensions: wikiExtensions(), content: '<p></p><p>Other</p>' });
  editor.commands.setTextSelection(1);
  renders = 0;
});
afterEach(() => { cleanup(); editor.destroy(); });

describe('useTrigger', () => {
  it('does not re-render for changes that leave the trigger as it was (remote typing)', () => {
    render(<Probe />);
    act(() => { editor.commands.insertContent('/he'); });
    const settled = renders;
    // someone else types in the next paragraph
    act(() => {
      const end = editor.state.doc.content.size - 1;
      editor.view.dispatch(editor.state.tr.insertText('!', end));
    });
    act(() => { editor.view.dispatch(editor.state.tr.setMeta('noop', true)); });
    expect(renders).toBe(settled);
    act(() => { editor.commands.insertContent('a'); });
    expect(renders).toBe(settled + 1);
  });
});
