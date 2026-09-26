/** The page's table of contents and its heading anchors. Ids are derived,
 *  never stored: `buildToc` reads them from the stored JSON (the right
 *  rail), and the `HeadingIds` extension puts the very same ids on the
 *  rendered headings (editor and read-only view) with node decorations, so
 *  the stored schema — shared with the server — stays unchanged. */
import { Extension, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface TocEntry {
  level: number;
  text: string;
  /** The heading's element id ("h-" + slug, "-2", "-3"… for repeats). */
  id: string;
}

/** "Before you start" → "before-you-start"; accents folded, punctuation
 *  dropped, at most 60 characters, "section" when nothing is left. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Ids for headings in document order: the slug, then "-2", "-3"… */
function assignIds(headings: { level: number; text: string }[]): TocEntry[] {
  const used = new Set<string>();
  return headings.map(({ level, text }) => {
    const base = `h-${slugify(text)}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return { level, text, id };
  });
}

function jsonText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'pageLink') return String(node.attrs?.title ?? '');
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(jsonText).join('');
}

/** Every non-empty heading (nested ones included), in document order. */
export function buildToc(doc: JSONContent | null | undefined): TocEntry[] {
  const found: { level: number; text: string }[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'heading') {
      const text = clean(jsonText(node));
      if (text) found.push({ level: Number(node.attrs?.level) || 1, text });
      return;
    }
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return assignIds(found);
}

function pmText(node: PMNode): string {
  let out = '';
  node.descendants((child) => {
    if (child.isText) out += child.text ?? '';
    else if (child.type.name === 'pageLink') out += String(child.attrs.title ?? '');
    else if (child.type.name === 'hardBreak') out += ' ';
    return true;
  });
  return out;
}

/** The same entries as `buildToc`, read from a ProseMirror document, with
 *  each heading's position. */
export function headingIdsOf(doc: PMNode): (TocEntry & { pos: number; size: number })[] {
  const found: { level: number; text: string; pos: number; size: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    const text = clean(pmText(node));
    if (text) found.push({ level: Number(node.attrs.level) || 1, text, pos, size: node.nodeSize });
    return false;
  });
  const ids = assignIds(found);
  return found.map((h, i) => ({ ...ids[i], pos: h.pos, size: h.size }));
}

function decorate(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, headingIdsOf(doc).map(
    (h) => Decoration.node(h.pos, h.pos + h.size, { id: h.id })));
}

const headingIdsKey = new PluginKey<DecorationSet>('wikiHeadingIds');

/** Gives every rendered heading its table-of-contents id. */
export const HeadingIds = Extension.create({
  name: 'wikiHeadingIds',

  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: headingIdsKey,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
      },
      props: {
        decorations: (state) => headingIdsKey.getState(state),
      },
    })];
  },
});
