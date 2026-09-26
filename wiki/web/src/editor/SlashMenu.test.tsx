// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wikiExtensions } from './schema';
import SlashMenu from './SlashMenu';

let editor: Editor;
const actions = { pickImage: vi.fn(), pickFile: vi.fn(), pickPage: vi.fn() };

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions: wikiExtensions(), content: '<p></p>' });
  Object.values(actions).forEach((fn) => fn.mockReset());
});
afterEach(() => {
  cleanup();
  editor.destroy();
  document.body.replaceChildren();
});

const type = (text: string) => act(() => { editor.commands.insertContent(text); });
const key = (k: string) => act(() => { fireEvent.keyDown(editor.view.dom, { key: k }); });
const labels = () => within(screen.getByRole('listbox', { name: 'Insert a block' }))
  .getAllByRole('option').map((o) => o.getAttribute('data-label'));

describe('SlashMenu', () => {
  it('opens on "/" at the start of an empty block with every block type', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/');
    expect(labels()).toEqual(expect.arrayContaining([
      'Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'To-do list',
      'Quote', 'Code block', 'Callout', 'Collapsible section', 'Table', 'Divider', 'Image', 'File',
      'Page link',
    ]));
  });

  it('filters as you type and inserts the chosen heading with the keyboard', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    type('/hea');
    expect(labels()).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    key('ArrowDown');
    key('Enter');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.getJSON().content?.[0]).toEqual({
      type: 'heading', attrs: { textAlign: null, level: 2 },
    });
  });

  it('inserts on click and hands pickers to the editor', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    type('/image');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Image/ }));
    expect(actions.pickImage).toHaveBeenCalled();
    expect(editor.getText()).toBe('');
  });

  it('closes on Escape and stays closed while typing on in that block', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    type('/ta');
    expect(screen.getByRole('listbox')).toBeTruthy();
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('b');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.getText()).toBe('/tab');
  });

  it('does not open for a slash inside text', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    type('and/or');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says so when nothing matches', () => {
    render(<SlashMenu editor={editor} actions={actions} />);
    type('/zzz');
    expect(screen.getByText('No matching blocks')).toBeTruthy();
  });
});
