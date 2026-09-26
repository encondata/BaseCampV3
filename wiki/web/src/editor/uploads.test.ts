// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  startUpload: vi.fn(),
  completeUpload: vi.fn(),
}));

import { completeUpload, startUpload } from '../lib/wikiApi';
import { FakeXhr } from '../testing/fakeXhr';
import { wikiExtensions } from './schema';
import { FileHandling } from './uploads';

let editor: Editor;
const onError = vi.fn();

function paste(files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types: files.length ? ['Files'] : [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  FakeXhr.reset();
  FakeXhr.autoRespond = 200;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  onError.mockReset();
  vi.mocked(startUpload).mockReset().mockResolvedValue({
    upload_id: 'up-1', url: 'https://s3/put', headers: { 'Content-Type': 'image/png' },
  });
  vi.mocked(completeUpload).mockReset().mockResolvedValue({
    id: 'asset-1', filename: 'rack.png', content_type: 'image/png', size_bytes: 4,
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [...wikiExtensions(), FileHandling.configure({ pageId: 'page-1', onError })],
    content: '<p></p>',
  });
});
afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const blocks = () => editor.getJSON().content ?? [];

describe('pasting files', () => {
  it('uploads a pasted image as a page asset and inserts it', async () => {
    const png = new File(['PNG!'], 'rack.png', { type: 'image/png' });
    const event = paste([png]);
    expect(event.defaultPrevented).toBe(true);
    // a placeholder shows while it uploads
    expect(editor.view.dom.querySelector('.wiki-upload-placeholder')).not.toBeNull();

    await vi.waitFor(() => expect(blocks().some((b) => b.type === 'wikiImage')).toBe(true));
    expect(startUpload).toHaveBeenCalledWith({
      target: 'asset', page_id: 'page-1', filename: 'rack.png', content_type: 'image/png', size: 4,
    });
    expect(FakeXhr.instances[0].url).toBe('https://s3/put');
    expect(FakeXhr.instances[0].headers).toEqual({ 'Content-Type': 'image/png' });
    expect(FakeXhr.instances[0].body).toBe(png);
    expect(completeUpload).toHaveBeenCalledWith('up-1');
    expect(blocks().find((b) => b.type === 'wikiImage')).toEqual({
      type: 'wikiImage', attrs: { assetId: 'asset-1', alt: '', caption: '', width: null },
    });
    expect(editor.view.dom.querySelector('.wiki-upload-placeholder')).toBeNull();
  });

  it('embeds any other file as a file card', async () => {
    vi.mocked(completeUpload).mockResolvedValue({
      id: 'asset-2', filename: 'manual.pdf', content_type: 'application/pdf', size_bytes: 3,
    });
    paste([new File(['pdf'], 'manual.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect(blocks().some((b) => b.type === 'fileEmbed')).toBe(true));
    expect(blocks().find((b) => b.type === 'fileEmbed')).toEqual({
      type: 'fileEmbed',
      attrs: { nodeId: null, assetId: 'asset-2', filename: 'manual.pdf', contentType: 'application/pdf' },
    });
  });

  it('leaves ordinary text pastes to the editor', () => {
    paste([], 'hello');
    expect(startUpload).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('hello');
  });

  it('pastes the text of a paste that also carries a snapshot image (office apps)', () => {
    paste([new File(['x'], 'snapshot.png', { type: 'image/png' })], 'Quarterly totals');
    expect(startUpload).not.toHaveBeenCalled();
    expect(editor.getText()).toBe('Quarterly totals');
  });

  it('removes the placeholder and reports a failed upload', async () => {
    FakeXhr.autoRespond = 403;
    paste([new File(['x'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/a\.png/);
    expect(completeUpload).not.toHaveBeenCalled();
    expect(blocks().some((b) => b.type === 'wikiImage')).toBe(false);
    expect(editor.view.dom.querySelector('.wiki-upload-placeholder')).toBeNull();
  });
});
