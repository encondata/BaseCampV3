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

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function drop(target: Editor, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'], getData: () => '' } });
  Object.assign(event, { clientX: 0, clientY: 0 });
  target.view.dom.dispatchEvent(event);
}

describe('uploads in order', () => {
  it('lands files dropped together in drop order, whichever finishes first', async () => {
    vi.mocked(startUpload).mockImplementation(async (body) => ({
      upload_id: `up-${body.filename}`, url: 'https://s3/put', headers: {},
    }));
    const done = { 'a.png': deferred<unknown>(), 'b.png': deferred<unknown>() };
    vi.mocked(completeUpload).mockImplementation(
      (id: string) => done[id.slice(3) as keyof typeof done].promise as ReturnType<typeof completeUpload>);
    editor.commands.setContent('<p>Intro</p>');
    editor.commands.setTextSelection(3);
    drop(editor, [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(2));

    done['b.png'].resolve({ id: 'asset-b', filename: 'b.png', content_type: 'image/png', size_bytes: 1 });
    done['a.png'].resolve({ id: 'asset-a', filename: 'a.png', content_type: 'image/png', size_bytes: 1 });
    await vi.waitFor(() => expect(blocks().filter((b) => b.type === 'wikiImage')).toHaveLength(2));
    expect(blocks().filter((b) => b.type === 'wikiImage').map((b) => b.attrs?.assetId))
      .toEqual(['asset-a', 'asset-b']);
  });
});

describe('uploads while someone else edits', () => {
  it('still lands the upload after a remote change replaces the whole document', async () => {
    const { Collaboration } = await import('@tiptap/extension-collaboration');
    const Y = await import('yjs');
    const { ySyncPluginKey } = await import('y-prosemirror');
    const doc = new Y.Doc();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const live = new Editor({
      element: el,
      extensions: [
        ...wikiExtensions().filter((e) => e.name !== 'starterKit'),
        (await import('@tiptap/starter-kit')).StarterKit.configure({ history: false, codeBlock: false }),
        Collaboration.configure({ document: doc, field: 'default' }),
        FileHandling.configure({ pageId: 'page-1', onError }),
      ],
    });
    // the sync binding arrives a tick after the view
    await vi.waitFor(() => expect(ySyncPluginKey.getState(live.state)?.binding).toBeTruthy());
    // mid-document, so the landing spot is inside the replaced range
    live.commands.setContent('<p>Hello</p><p>World</p>');
    live.commands.setTextSelection(6);

    const finish = deferred<unknown>();
    vi.mocked(completeUpload).mockReturnValue(finish.promise as ReturnType<typeof completeUpload>);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['PNG!'], 'rack.png', { type: 'image/png' })], items: [], types: ['Files'], getData: () => '' },
    });
    live.view.dom.dispatchEvent(event);
    await vi.waitFor(() => expect(completeUpload).toHaveBeenCalled());

    // a collaborator adds a line at the top: y-prosemirror replaces the whole doc
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('Remote line')]);
    other.getXmlFragment('default').insert(0, [para]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(live.getText()).toContain('Remote line');

    finish.resolve({ id: 'asset-1', filename: 'rack.png', content_type: 'image/png', size_bytes: 4 });
    await vi.waitFor(() => expect((live.getJSON().content ?? []).some((b) => b.type === 'wikiImage')).toBe(true));
    expect((live.getJSON().content ?? []).map((b) => b.type === 'paragraph' ? b.content?.[0]?.text : b.type))
      .toEqual(['Remote line', 'Hello', 'wikiImage', 'World']);
    expect(onError).not.toHaveBeenCalled();
    live.destroy();
  });
});

describe('uploads that cannot land', () => {
  it('says so when the editor closed before the upload finished', async () => {
    const finish = deferred<unknown>();
    vi.mocked(completeUpload).mockReturnValue(finish.promise as ReturnType<typeof completeUpload>);
    paste([new File(['PNG!'], 'rack.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(completeUpload).toHaveBeenCalled());
    editor.destroy();
    finish.resolve({ id: 'asset-1', filename: 'rack.png', content_type: 'image/png', size_bytes: 4 });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/rack\.png/);
  });
});
