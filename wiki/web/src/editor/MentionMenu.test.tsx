// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listMentionable: vi.fn(),
}));

import { clearPersonNames, personName } from '../lib/personNames';
import { listMentionable } from '../lib/wikiApi';
import MentionMenu from './MentionMenu';
import { wikiExtensions } from './schema';

let editor: Editor;

beforeEach(() => {
  clearPersonNames();
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions: wikiExtensions(), content: '<p></p>' });
  vi.mocked(listMentionable).mockReset();
  vi.mocked(listMentionable).mockResolvedValue([
    { id: 'p-1', name: 'Pat Doe' }, { id: 'p-2', name: 'Pam Roe' },
  ]);
});
afterEach(() => {
  cleanup();
  editor.destroy();
  document.body.replaceChildren();
});

const type = (text: string) => act(() => { editor.commands.insertContent(text); });
const key = (k: string) => act(() => { fireEvent.keyDown(editor.view.dom, { key: k }); });
const para = () => editor.getJSON().content?.[0].content;

describe('MentionMenu (@)', () => {
  it('lists people who can view the page and inserts a mention and a space', async () => {
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('Ask ');
    type('@');
    type('p');
    type('a');
    expect(await screen.findByRole('option', { name: /Pat Doe/ })).toBeTruthy();
    // debounced: only the settled query is asked for
    expect(listMentionable).toHaveBeenCalledTimes(1);
    expect(listMentionable).toHaveBeenLastCalledWith('page-1', 'pa');

    key('Enter');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(para()).toEqual([
      { type: 'text', text: 'Ask ' },
      { type: 'mention', attrs: { personId: 'p-1', label: 'Pat Doe' } },
      { type: 'text', text: ' ' },
    ]);
    // the editor shows this person's name from now on
    expect(personName('p-1')).toBe('Pat Doe');
  });

  it('opens on a bare @ at the start of a block, and takes a first and last name', async () => {
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('@');
    // no search until two letters are typed
    expect(await screen.findByText('Type 2 or more letters of a name')).toBeTruthy();
    type('P');
    await new Promise((r) => { setTimeout(r, 200); });
    expect(listMentionable).not.toHaveBeenCalled();
    type('at D');
    await vi.waitFor(() => expect(listMentionable).toHaveBeenLastCalledWith('page-1', 'Pat D'));
  });

  it('picks with the arrow keys and the mouse', async () => {
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('@pa');
    await screen.findByRole('option', { name: /Pam Roe/ });
    key('ArrowDown');
    expect(screen.getByRole('option', { name: /Pam Roe/ }).getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    expect(screen.getByRole('option', { name: /Pat Doe/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Pam Roe/ }));
    expect(para()?.[0]).toEqual({ type: 'mention', attrs: { personId: 'p-2', label: 'Pam Roe' } });
  });

  it('does not open inside a word (an email address)', async () => {
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('ops@example');
    await new Promise((r) => { setTimeout(r, 200); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(listMentionable).not.toHaveBeenCalled();
  });

  it('closes on Escape and leaves Enter to the editor', async () => {
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('@pa');
    await screen.findByRole('listbox');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(para()).toEqual([{ type: 'text', text: '@pa' }]);
  });

  it('says when no one matches', async () => {
    vi.mocked(listMentionable).mockResolvedValue([]);
    render(<MentionMenu editor={editor} pageId="page-1" />);
    type('@zz');
    expect(await screen.findByText('No one who can view this page matches “zz”')).toBeTruthy();
  });
});
