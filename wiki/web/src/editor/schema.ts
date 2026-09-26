/** The wiki's content schema — ONE extension list shared by the live
 *  editor, the read-only renderer and the wiki server's HTML export
 *  (server/ compiles this file with its own tsconfig; relative imports
 *  carry `.js` so Node's ESM resolver finds the compiled files).
 *
 *  Everything here must stay DOM-free: no React, no node views, no
 *  `document` at import or render time. The editor adds its node views on
 *  top with `.extend({ addNodeView })`. Changing a node's name, attributes
 *  or HTML changes stored documents — the API's text extraction
 *  (serversherpa/wiki/content.py) reads the same attribute names. */
import type { Attributes, Extensions, JSONContent } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCursor } from '@tiptap/extension-collaboration-cursor';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Highlight } from '@tiptap/extension-highlight';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { TextAlign } from '@tiptap/extension-text-align';
import { Typography } from '@tiptap/extension-typography';
import { Underline } from '@tiptap/extension-underline';
import { StarterKit } from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import type { Doc } from 'yjs';

import { Callout } from './extensions/Callout.js';
import { renderCursor, renderSelection } from './extensions/cursors.js';
import { Details, DetailsContent, DetailsSummary } from './extensions/Details.js';
import { FileEmbed } from './extensions/FileEmbed.js';
import { PageLink } from './extensions/PageLink.js';
import { WikiImage } from './extensions/WikiImage.js';

/** A new page's content: one empty paragraph (the API's EMPTY_DOC). */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Link targets a page may hold: web, mail and phone links, and internal
 *  wiki routes. Anything else (javascript:, data:, protocol-relative, …)
 *  is dropped on parse and stripped on render. */
const ALLOWED_HREF = /^(https?:|mailto:|tel:|\/n\/)/i;
export const isAllowedHref = (href: string): boolean => ALLOWED_HREF.test(href);

const lowlight = createLowlight(common);

/* Two stock extensions parse or render through DOM APIs the server's
 * zeed-dom (inside @tiptap/html) doesn't have: ProseMirror sets `style`
 * via `style.cssText` (silently lost there) and CodeBlock reads its
 * language from `firstElementChild.classList` (missing there). These
 * overrides use plain attributes so both sides agree. */

/** TextAlign that also renders `data-text-align` and parses it (or the
 *  inline style) with getAttribute. */
const WikiTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    const { types, alignments, defaultAlignment } = this.options;
    const alignmentOf = (el: HTMLElement): string | null => {
      const value = el.getAttribute('data-text-align')
        ?? /(?:^|;)\s*text-align\s*:\s*([a-z]+)/i.exec(el.getAttribute('style') ?? '')?.[1];
      return value && alignments.includes(value.toLowerCase()) ? value.toLowerCase() : defaultAlignment;
    };
    return [{
      types,
      attributes: {
        textAlign: {
          default: defaultAlignment,
          parseHTML: alignmentOf,
          // stored JSON is client-supplied: only a known alignment reaches the style
          renderHTML: (attrs) => (alignments.includes(attrs.textAlign)
            ? { 'data-text-align': attrs.textAlign, style: `text-align: ${attrs.textAlign}` }
            : {}),
        },
      },
    }];
  },
});

/** CodeBlockLowlight whose language parses from `<code class="language-…">`
 *  with querySelector/getAttribute. */
const WikiCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Attributes;
    const prefix = this.options.languageClassPrefix;
    return {
      ...parent,
      language: {
        ...parent.language,
        parseHTML: (el: HTMLElement) => {
          const classes = (el.querySelector('code')?.getAttribute('class') ?? '').split(/\s+/);
          const hit = classes.find((c) => c.startsWith(prefix) && c.length > prefix.length);
          return hit ? hit.slice(prefix.length) : null;
        },
      },
    };
  },
});

export interface WikiCollabOptions {
  /** The page's Y.Doc; the Collaboration extension syncs its `default` field. */
  doc: Doc;
  /** The HocuspocusProvider — its awareness drives the other editors' cursors. */
  provider?: unknown;
  user?: { name: string; color: string };
}

export interface WikiExtensionOptions {
  collab?: WikiCollabOptions;
  placeholder?: string;
}

export function wikiExtensions(opts: WikiExtensionOptions = {}): Extensions {
  const { collab, placeholder } = opts;
  const extensions: Extensions = [
    StarterKit.configure({
      codeBlock: false,                              // CodeBlockLowlight below
      ...(collab ? { history: false } : {}),         // Yjs owns undo while collaborating
    }),
    Link.configure({
      protocols: [],
      isAllowedUri: (url) => isAllowedHref(url),
      shouldAutoLink: (url) => isAllowedHref(url),
    }),
    Underline,
    Highlight,
    WikiTextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    WikiCodeBlock.configure({ lowlight }),
    Typography,
    Callout,
    Details,
    DetailsSummary,
    DetailsContent,
    WikiImage,
    FileEmbed,
    PageLink,
  ];
  if (placeholder) extensions.push(Placeholder.configure({ placeholder }));
  if (collab) {
    // the wiki server stores and seeds this same field (server/src/collab.ts COLLAB_FIELD)
    extensions.push(Collaboration.configure({ document: collab.doc, field: 'default' }));
    if (collab.provider) {
      extensions.push(CollaborationCursor.configure({
        provider: collab.provider,
        // other people's awareness is untrusted: draw it without style strings
        render: renderCursor,
        selectionRender: renderSelection,
        ...(collab.user ? { user: collab.user } : {}),
      }));
    }
  }
  return extensions;
}
