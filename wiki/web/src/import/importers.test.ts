// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseName, importFile, importKind, markdownToDoc, textToDoc } from './importers';

// (jsdom gives import.meta.url an http: scheme, so resolve from the directory)
const SAMPLE = readFileSync(resolve(__dirname, 'fixtures/sample.docx'));

const types = (doc: JSONContent) => (doc.content ?? []).map((b) => b.type);
const textOf = (node: JSONContent): string =>
  node.type === 'text' ? node.text ?? '' : (node.content ?? []).map(textOf).join('');

function find(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === type) out.push(n);
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__pwned;
  document.body.replaceChildren();
});

describe('importKind / baseName', () => {
  it('knows the importable extensions, case-insensitively', () => {
    expect(importKind('Plan.DOCX')).toBe('docx');
    expect(importKind('notes.md')).toBe('markdown');
    expect(importKind('notes.markdown')).toBe('markdown');
    expect(importKind('readme.txt')).toBe('text');
    expect(importKind('sheet.xlsx')).toBeNull();
    expect(importKind('docx')).toBeNull();
    expect(baseName('Rack plan.v2.docx')).toBe('Rack plan.v2');
    expect(baseName('.md')).toBe('.md');
  });
});

describe('importFile: .docx', () => {
  it('converts headings, paragraphs, lists, tables and uploads embedded images as page assets', async () => {
    const uploadAsset = vi.fn().mockResolvedValue('asset-7');
    const file = new File([SAMPLE], 'Sample.docx');
    const { title, doc, warnings } = await importFile(file, { uploadAsset });

    // the first heading 1 is the title, and leaves the body
    expect(title).toBe('Rack plan');
    expect(types(doc)).toEqual(['paragraph', 'heading', 'bulletList', 'wikiImage', 'table']);
    expect(find(doc, 'heading').map((h) => h.attrs?.level)).toEqual([2]);

    const [para] = doc.content!;
    expect(textOf(para)).toBe('Power down the rack before moving it. Label every cable.');
    expect(para.content?.[1].marks).toEqual([{ type: 'bold' }]);
    expect(find(doc, 'listItem').map(textOf)).toEqual(['Unplug the PDUs', 'Remove the rails']);
    expect(find(doc, 'tableCell').map(textOf)).toEqual(['Rack', 'Units', 'A1', '42']);

    expect(uploadAsset).toHaveBeenCalledTimes(1);
    const [blob, name] = uploadAsset.mock.calls[0] as [Blob, string];
    expect(blob.type).toBe('image/png');
    expect(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()).slice(1, 4))).toBe('PNG');
    expect(name).toBe('image-1.png');
    expect(find(doc, 'wikiImage')[0].attrs).toMatchObject({ assetId: 'asset-7', alt: 'Red dot' });
    expect(warnings).toEqual([]);
  });

  it('leaves out an image that fails to upload, and says so', async () => {
    const uploadAsset = vi.fn().mockRejectedValue(new Error('storage down'));
    const { doc, warnings } = await importFile(new File([SAMPLE], 'Sample.docx'), { uploadAsset });
    expect(find(doc, 'wikiImage')).toEqual([]);
    expect(find(doc, 'image')).toEqual([]);
    expect(warnings).toEqual(["An image (image-1.png) couldn't be uploaded and was left out."]);
  });

  it('skips EMF/WMF images (browsers can\'t display them) instead of uploading something undisplayable', async () => {
    vi.doMock('mammoth', () => ({
      default: {
        images: { imgElement: (convert: (image: unknown) => Promise<{ src: string }>) => convert },
        convertToHtml: async (
          _input: unknown, opts: { convertImage: (image: unknown) => Promise<{ src: string }> },
        ) => {
          const asTag = (r: { src: string }) => (r.src ? `<img src="${r.src}" alt="">` : '');
          const wmf = await opts.convertImage({ contentType: 'image/x-wmf', readAsArrayBuffer: async () => new ArrayBuffer(4) });
          const png = await opts.convertImage({ contentType: 'image/png', readAsArrayBuffer: async () => new ArrayBuffer(4) });
          return { value: `<p>${asTag(wmf)}${asTag(png)}</p>` };
        },
      },
    }));
    vi.resetModules();
    const { importFile: importFileFresh } = await import('./importers');
    const uploadAsset = vi.fn().mockResolvedValue('asset-9');
    const { doc, warnings } = await importFileFresh(new File(['x'], 'Plan.docx'), { uploadAsset });
    // only the displayable image is uploaded and embedded
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    expect(find(doc, 'wikiImage')).toHaveLength(1);
    expect(find(doc, 'wikiImage')[0].attrs).toMatchObject({ assetId: 'asset-9' });
    expect(warnings).toEqual(["Some images couldn't be imported."]);
    vi.doUnmock('mammoth');
    vi.resetModules();
  });
});

describe('importFile: Markdown', () => {
  it('converts headings, lists and fenced code, taking the first H1 as the title', async () => {
    const md = [
      'Intro line', '', '# Cutover runbook', '', '## Before', '', '- one', '- two', '',
      '1. first', '2. second', '', '```bash', 'ssh rack-a1', '```', '', '# Second H1 stays',
    ].join('\n');
    const { title, doc } = await importFile(new File([md], 'runbook.md'), { uploadAsset: vi.fn() });
    expect(title).toBe('Cutover runbook');
    expect(types(doc)).toEqual(['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'heading']);
    expect(find(doc, 'heading').map((h) => [h.attrs?.level, textOf(h)]))
      .toEqual([[2, 'Before'], [1, 'Second H1 stays']]);
    const code = find(doc, 'codeBlock')[0];
    expect(code.attrs?.language).toBe('bash');
    expect(textOf(code)).toBe('ssh rack-a1');
  });

  it('uses the file name when there is no heading 1', async () => {
    const { title } = await importFile(new File(['## Only h2'], 'Site notes.markdown'), { uploadAsset: vi.fn() });
    expect(title).toBe('Site notes');
  });

  it('never runs or keeps raw HTML: no script, no handler, no image, no javascript: link', async () => {
    const md = [
      'Hello <img src=x onerror="globalThis.__pwned = 1"> there',
      '',
      '<script>globalThis.__pwned = 2</script>',
      '',
      '<div onclick="globalThis.__pwned = 3">div text</div>',
      '',
      '[bad](javascript:globalThis.__pwned=4) [good](https://example.com)',
    ].join('\n');
    const { doc } = await importFile(new File([md], 'x.md'), { uploadAsset: vi.fn() });
    await new Promise((r) => setTimeout(r, 20));
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect(document.querySelectorAll('img, script').length).toBe(0);
    expect(find(doc, 'wikiImage')).toEqual([]);
    const all = JSON.stringify(doc);
    expect(all).not.toContain('javascript:');
    expect(all).not.toContain('__pwned');
    expect(all).toContain('https://example.com');
    expect(textOf(doc)).toContain('div text');
  });

  it('markdownToDoc is the same sanitizing parse', () => {
    const doc = markdownToDoc('**bold** <iframe src="https://evil"></iframe>');
    expect(JSON.stringify(doc)).not.toContain('iframe');
    expect(doc.content?.[0].content?.[0]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] });
  });
});

describe('importFile: plain text', () => {
  it('splits paragraphs on blank lines, keeps line breaks, and never parses markup', async () => {
    const txt = '# not a heading\r\nsecond line\r\n\r\n\r\n<b>literal</b>\n';
    const { title, doc } = await importFile(new File([txt], 'readme.txt'), { uploadAsset: vi.fn() });
    expect(title).toBe('readme');
    expect(doc).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'text', text: '# not a heading' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' },
        ] },
        { type: 'paragraph', content: [{ type: 'text', text: '<b>literal</b>' }] },
      ],
    });
  });

  it('gives an empty file one empty paragraph', () => {
    expect(textToDoc('  \n\n')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});

it('refuses a file type it has no importer for', async () => {
  await expect(importFile(new File(['x'], 'sheet.xlsx'), { uploadAsset: vi.fn() }))
    .rejects.toThrow('“sheet.xlsx” can\'t be imported. Choose a .docx, .md or .txt file.');
});
