/** Page JSON → HTML for exports, with the same shared schema the editor
 *  and the read-only renderer use, so an export looks like the page. The
 *  schema only emits what its nodes and marks render (links limited to
 *  its allowlist), so the output needs no further sanitizing. */
import type { JSONContent } from '@tiptap/core';
import { generateHTML } from '@tiptap/html';

import { wikiExtensions } from '../../web/src/editor/schema.js';

const extensions = wikiExtensions();

/** Throws when `doc` isn't a document the schema accepts. */
export function renderDocHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('A document must be a JSON object.');
  }
  return generateHTML(doc as JSONContent, extensions);
}
