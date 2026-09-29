// @vitest-environment jsdom
import '../testing/pmDom';

import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { insertDetails } from './blocks';
import { withNodeViews } from './nodeViews';
import { wikiExtensions } from './schema';

let editor: Editor | null = null;

function Harness() {
  const ed = useEditor({ extensions: withNodeViews(wikiExtensions()), content: '<p></p>' });
  editor = ed;
  return <EditorContent editor={ed} />;
}

afterEach(() => { cleanup(); editor = null; });

const key = (k: string) => act(() => { fireEvent.keyDown(editor!.view.dom, { key: k }); });

describe('collapsible sections in the editor', () => {
  it('inserts with the cursor in the summary; Enter moves into the content, open', async () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);
    act(() => { insertDetails(editor!); });
    act(() => { editor!.commands.insertContent('Why not hot-swap?'); });
    expect(editor!.state.selection.$from.parent.type.name).toBe('detailsSummary');
    key('Enter');
    expect(editor!.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor!.state.selection.$from.node(-1).type.name).toBe('detailsContent');
    expect((await screen.findByRole('button', { name: 'Collapse section' })).getAttribute('aria-expanded'))
      .toBe('true');
  });

  it('Backspace at the start of the summary unwraps the section', () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);
    act(() => { insertDetails(editor!); });
    act(() => { editor!.commands.insertContent('Title'); });
    key('Enter');
    act(() => { editor!.commands.insertContent('Body'); });
    act(() => { editor!.commands.setTextSelection(2); });   // details (0) > summary (1) > text
    expect(editor!.state.selection.$from.parent.type.name).toBe('detailsSummary');
    key('Backspace');
    expect(editor!.getJSON().content?.map((n) => n.content?.[0]?.text)).toEqual(['Title', 'Body']);
    expect(editor!.getJSON().content?.every((n) => n.type === 'paragraph')).toBe(true);
  });
});
