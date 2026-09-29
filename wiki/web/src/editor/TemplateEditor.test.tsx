// @vitest-environment jsdom
import '../testing/pmDom';

import type { Editor, JSONContent } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  search: vi.fn(),
}));

import { search } from '../lib/wikiApi';
import TemplateEditor from './TemplateEditor';

const DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Starting text' }] }] };

function renderTE(props: Partial<Parameters<typeof TemplateEditor>[0]> = {}) {
  return render(<MemoryRouter><TemplateEditor content={DOC} {...props} /></MemoryRouter>);
}

beforeEach(() => {
  toast.mockReset();
  vi.mocked(search).mockReset().mockResolvedValue([
    { node: { id: 'n9', kind: 'page', title: 'Cabling standards', space_key: 'ops', space_name: 'Operations' }, snippet_html: '', breadcrumbs: [] },
  ]);
});
afterEach(cleanup);

describe('TemplateEditor', () => {
  it('renders the initial content, editable', async () => {
    renderTE();
    expect(await screen.findByText('Starting text')).toBeTruthy();
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
  });

  it('reports content changes as the document is edited', async () => {
    let editor: Editor | null = null;
    const onChange = vi.fn();
    renderTE({ onChange, onEditor: (e) => { editor = e; } });
    await screen.findByText('Starting text');
    act(() => { editor?.commands.insertContent(' more'); });
    expect(onChange).toHaveBeenCalled();
    expect(editor!.getText()).toContain('more');
  });

  it('toggles bold from the toolbar', async () => {
    let editor: Editor | null = null;
    renderTE({ onEditor: (e) => { editor = e; } });
    await screen.findByText('Starting text');
    act(() => { editor?.commands.selectAll(); });
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(editor!.isActive('bold')).toBe(true);
  });

  it('refuses images and files — templates have nowhere to store an asset', async () => {
    renderTE();
    await screen.findByText('Starting text');
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(toast).toHaveBeenCalledWith('Templates can\'t include uploaded images or files.');
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('links to another page from the toolbar picker', async () => {
    let editor: Editor | null = null;
    renderTE({ onEditor: (e) => { editor = e; } });
    await screen.findByText('Starting text');
    fireEvent.click(screen.getByRole('button', { name: 'Page link' }));
    fireEvent.change(screen.getByLabelText('Search pages'), { target: { value: 'cab' } });
    const option = await screen.findByRole('option', { name: /Cabling standards/ });
    fireEvent.mouseDown(option);
    expect(editor!.getJSON()).toEqual(expect.objectContaining({
      content: expect.arrayContaining([
        expect.objectContaining({ content: expect.arrayContaining([
          expect.objectContaining({ type: 'pageLink', attrs: expect.objectContaining({ nodeId: 'n9' }) }),
        ]) }),
      ]),
    }));
  });
});
