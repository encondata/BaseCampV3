// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  search: vi.fn(),
}));

import type { SearchHit } from '../lib/types';
import { search } from '../lib/wikiApi';
import { PageLinkMenu } from './PagePicker';
import { wikiExtensions } from './schema';

const hit = (id: string, title: string): SearchHit => ({
  node: { id, kind: 'page', title, space_key: 'ops', space_name: 'Operations' },
  snippet_html: '',
  breadcrumbs: ['Guides'],
});

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions: wikiExtensions(), content: '<p></p>' });
  vi.mocked(search).mockReset();
  vi.mocked(search).mockResolvedValue([hit('n9', 'Cabling standards'), hit('n10', 'Cable colors')]);
});
afterEach(() => {
  cleanup();
  editor.destroy();
  document.body.replaceChildren();
});

const type = (text: string) => act(() => { editor.commands.insertContent(text); });

describe('PageLinkMenu ([[)', () => {
  it('searches pages as you type and inserts a page link', async () => {
    render(<PageLinkMenu editor={editor} />);
    type('See [[cab');
    expect(await screen.findByRole('option', { name: /Cabling standards/ })).toBeTruthy();
    expect(search).toHaveBeenLastCalledWith({ q: 'cab', kind: 'page', limit: 8 });

    act(() => { fireEvent.keyDown(editor.view.dom, { key: 'Enter' }); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: 'text', text: 'See ' },
      // the target's title is never stored — viewers look up the live one
      { type: 'pageLink', attrs: { nodeId: 'n9', title: '' } },
      { type: 'text', text: ' ' },
    ]);
  });

  it('picks with the arrow keys and the mouse', async () => {
    render(<PageLinkMenu editor={editor} />);
    type('[[cab');
    await screen.findByRole('option', { name: /Cable colors/ });
    act(() => { fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' }); });
    expect(screen.getByRole('option', { name: /Cable colors/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Cable colors/ }));
    expect(editor.getJSON().content?.[0].content?.[0]).toEqual(
      { type: 'pageLink', attrs: { nodeId: 'n10', title: '' } });
  });

  it('asks for a search term before searching', () => {
    render(<PageLinkMenu editor={editor} />);
    type('[[');
    expect(screen.getByText('Type to search pages')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });
});
