/** Turns an imported file into a page: `.docx` through mammoth, `.md` /
 *  `.markdown` through marked, `.txt` as paragraphs. Converted HTML is
 *  never put in the page's DOM: it is only parsed with the wiki's shared
 *  schema (`generateJSON`, which runs on @tiptap/html's own virtual DOM),
 *  so markup the schema doesn't know — scripts, event handlers, raw
 *  `<img>` tags — simply drops out, and unsupported constructs degrade to
 *  paragraphs. A `.docx`'s embedded images are uploaded as page assets
 *  (through `ctx.uploadAsset`) and land as `wikiImage` blocks.
 *
 *  The title is the first top-level heading 1 (taken out of the body),
 *  else the file name without its extension. */
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { marked } from 'marked';

import { wikiExtensions } from '../editor/schema';

export type ImportKind = 'docx' | 'markdown' | 'text';

const MAX_TITLE = 200;

export interface ImportContext {
  /** Uploads an embedded image as an asset of the new page; resolves to its asset id. */
  uploadAsset: (blob: Blob, name: string) => Promise<string>;
}

export interface ImportResult {
  title: string;
  doc: JSONContent;
  /** Things that didn't come across (an image that failed to upload). */
  warnings: string[];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Which importer handles `name`, or null when none does. */
export function importKind(name: string): ImportKind | null {
  switch (extensionOf(name)) {
    case '.docx': return 'docx';
    case '.md':
    case '.markdown': return 'markdown';
    case '.txt': return 'text';
    default: return null;
  }
}

/** Why `name` can't be imported (it has no importer). */
export function unsupportedMessage(name: string): string {
  return `“${name}” can't be imported. Choose a .docx, .md or .txt file.`;
}

/** The file name without its extension ("Rack plan.docx" → "Rack plan"). */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

let extensions: ReturnType<typeof wikiExtensions> | null = null;

/** HTML → ProseMirror JSON through the wiki schema only. */
export function htmlToDoc(html: string): JSONContent {
  extensions ??= wikiExtensions();
  return generateJSON(html, extensions) as JSONContent;
}

/** Drops the newline marked leaves at the end of every fenced code block. */
function trimCodeBlocks(node: JSONContent): void {
  if (node.type === 'codeBlock') {
    const last = node.content?.at(-1);
    if (last?.type === 'text' && last.text?.endsWith('\n')) {
      last.text = last.text.slice(0, -1);
      if (!last.text) node.content = node.content!.slice(0, -1);
    }
    return;
  }
  node.content?.forEach(trimCodeBlocks);
}

/** Markdown → ProseMirror JSON (the same sanitizing parse as `htmlToDoc`). */
export function markdownToDoc(markdown: string): JSONContent {
  const doc = htmlToDoc(marked.parse(markdown, { async: false, gfm: true }));
  trimCodeBlocks(doc);
  return doc;
}

/** Plain text → paragraphs: blank lines separate paragraphs, single line
 *  breaks stay line breaks. Built as JSON, so nothing is parsed as markup. */
export function textToDoc(text: string): JSONContent {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '');
  return {
    type: 'doc',
    content: paragraphs.length
      ? paragraphs.map((p) => ({
        type: 'paragraph',
        content: p.split('\n').flatMap((line, i) => [
          ...(i > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
      }))
      : [{ type: 'paragraph' }],
  };
}

function textOf(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
}

/** Takes the first top-level heading 1 out of `doc`, returning its text
 *  (null when there's none, or it's blank). */
function takeTitle(doc: JSONContent): string | null {
  const blocks = doc.content ?? [];
  const i = blocks.findIndex((b) => b.type === 'heading' && b.attrs?.level === 1);
  if (i < 0) return null;
  const title = textOf(blocks[i]).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const rest = blocks.filter((_, j) => j !== i);
  doc.content = rest.length ? rest : [{ type: 'paragraph' }];
  return title;
}

const IMAGE_EXTS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/tiff': 'tiff',
};

/** Windows metafile formats: browsers can't display them, so they're
 *  skipped rather than uploaded and embedded as an unrenderable image. */
const UNDISPLAYABLE_IMAGE_TYPES = new Set(['image/x-emf', 'image/x-wmf']);
const SKIPPED_IMAGES_WARNING = 'Some images couldn\'t be imported.';

async function docxToDoc(file: File, ctx: ImportContext, warnings: string[]): Promise<JSONContent> {
  // loaded on first use: the Markdown helpers here also serve the file view
  const { default: mammoth } = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  let n = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    n += 1;
    if (UNDISPLAYABLE_IMAGE_TYPES.has(image.contentType)) {
      if (!warnings.includes(SKIPPED_IMAGES_WARNING)) warnings.push(SKIPPED_IMAGES_WARNING);
      return { src: '' };
    }
    const name = `image-${n}.${IMAGE_EXTS[image.contentType] ?? 'bin'}`;
    try {
      const blob = new Blob([await image.readAsArrayBuffer()], { type: image.contentType });
      return { src: `asset:${await ctx.uploadAsset(blob, name)}` };
    } catch {
      warnings.push(`An image (${name}) couldn't be uploaded and was left out.`);
      return { src: '' };
    }
  });
  // the browser build reads `arrayBuffer`, the Node build (tests) `buffer`
  const input = { arrayBuffer, buffer: arrayBuffer } as unknown as Parameters<typeof mammoth.convertToHtml>[0];
  const { value } = await mammoth.convertToHtml(input, { convertImage, externalFileAccess: false });
  // an uploaded image becomes the schema's wikiImage block (asset id + alt);
  // mammoth quotes and escapes every attribute it writes
  const html = value.replace(/<img\b[^>]*>/g, (tag) => {
    const id = /\bsrc="asset:([^"]+)"/.exec(tag)?.[1];
    if (!id) return '';
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? '';
    return `<figure data-wiki-image="${id}"><img alt="${alt}"></figure>`;
  })
    // a paragraph holding only images is just the images (no empty paragraph left behind)
    .replace(/<p>((?:<figure data-wiki-image="[^"]*"><img alt="[^"]*"><\/figure>)+)<\/p>/g, '$1');
  return htmlToDoc(html);
}

/** Converts `file` into a title and a document; `.docx` images are uploaded on the way. */
export async function importFile(file: File, ctx: ImportContext): Promise<ImportResult> {
  const kind = importKind(file.name);
  const warnings: string[] = [];
  let doc: JSONContent;
  if (kind === 'docx') doc = await docxToDoc(file, ctx, warnings);
  else if (kind === 'markdown') doc = markdownToDoc(await file.text());
  else if (kind === 'text') doc = textToDoc(await file.text());
  else throw new Error(unsupportedMessage(file.name));

  if (!doc.content?.length) doc.content = [{ type: 'paragraph' }];
  const heading = kind === 'text' ? null : takeTitle(doc);
  const title = (heading ?? baseName(file.name) ?? '').slice(0, MAX_TITLE).trim() || 'Untitled';
  return { title, doc, warnings };
}
