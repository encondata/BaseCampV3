/** The shared schema runs where there is no DOM (the wiki server renders
 *  exports with it), so these tests stay in the node environment. */
import { getSchema } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  FIXTURE_FILE_NODE,
  FIXTURE_IMAGE_ASSET,
  FIXTURE_PAGE_NODE,
  fixtureDoc,
} from './fixtures';
import { EMPTY_DOC, wikiExtensions } from './schema';

const html = () => generateHTML(fixtureDoc, wikiExtensions());

function linkDoc(href: string) {
  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'click me',
        marks: [{ type: 'link', attrs: { href } }],
      }],
    }],
  };
}

function marksIn(doc: { content?: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { marks?: { type: string }[]; content?: unknown[] };
    n.marks?.forEach((m) => out.push(m.type));
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

describe('wikiExtensions: custom nodes render to HTML', () => {
  it('renders a callout with its variant', () => {
    expect(html()).toContain('<div data-callout="warning"><p>Never hot-swap the PDU.</p></div>');
  });

  it('renders a wiki image by asset id, never a src', () => {
    const out = html();
    expect(out).toContain(
      `<figure data-wiki-image="${FIXTURE_IMAGE_ASSET}" data-width="480">`
      + '<img alt="Rack front view"><figcaption>Rack 12, front</figcaption></figure>',
    );
    expect(out).not.toMatch(/<img[^>]*\ssrc=/);
  });

  it('renders a file embed card with its identifiers', () => {
    expect(html()).toContain(
      `<div data-file-embed="" data-node-id="${FIXTURE_FILE_NODE}" `
      + 'data-filename="pdu-manual.pdf" data-content-type="application/pdf">'
      + 'pdu-manual.pdf</div>',
    );
  });

  it('renders a page link to the wiki route with the title', () => {
    expect(html()).toContain(
      `<a data-page-link="${FIXTURE_PAGE_NODE}" href="/n/${FIXTURE_PAGE_NODE}">Cabling standards</a>`,
    );
  });

  // Without a DOM (@tiptap/html on zeed-dom) ProseMirror's `style.cssText`
  // assignment is lost, so alignment must survive as a data attribute.
  it('keeps text alignment when rendered without a DOM', () => {
    expect(html()).toContain('<p data-text-align="center"');
  });

  it('renders only a known alignment into the style attribute', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'left; background: url(x)' } }],
    };
    expect(generateHTML(doc, wikiExtensions())).toBe('<p></p>');
  });

  it('renders a code block with its language class', () => {
    expect(html()).toContain('<pre><code class="language-bash">ipmitool power status</code></pre>');
  });

  it('renders a collapsible section as a native details element', () => {
    expect(html()).toContain(
      '<details data-details=""><summary>Why not hot-swap?</summary>'
      + '<div data-details-content=""><p>The PDU has no redundant feed.</p></div></details>',
    );
  });

  it('renders the empty document as one empty paragraph', () => {
    expect(EMPTY_DOC).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(generateHTML(EMPTY_DOC, wikiExtensions())).toBe('<p></p>');
  });
});

describe('wikiExtensions: links', () => {
  it.each([
    'https://example.com/a',
    'http://example.com',
    'mailto:ops@example.com',
    'tel:+15551234567',
    `/n/${FIXTURE_PAGE_NODE}`,
  ])('keeps an allowed href (%s)', (href) => {
    expect(generateHTML(linkDoc(href), wikiExtensions())).toContain(`href="${href}"`);
    const parsed = generateJSON(`<p><a href="${href}">x</a></p>`, wikiExtensions());
    expect(marksIn(parsed)).toEqual(['link']);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/file',
    '//evil.example.com/x',
  ])('drops a disallowed href (%s)', (href) => {
    const out = generateHTML(linkDoc(href), wikiExtensions());
    expect(out).not.toContain(href.split(':')[0] + ':');
    expect(out).not.toContain('evil.example.com');
    const parsed = generateJSON(`<p><a href="${href.replace(/"/g, '&quot;')}">x</a></p>`,
      wikiExtensions());
    expect(marksIn(parsed)).toEqual([]);
  });
});

describe('wikiExtensions: HTML round trip', () => {
  it('parses its own HTML back to the same document', () => {
    expect(generateJSON(html(), wikiExtensions())).toEqual(fixtureDoc);
  });

  it('falls back to the info variant for an unknown callout variant', () => {
    const parsed = generateJSON('<div data-callout="shouting"><p>Hi</p></div>', wikiExtensions());
    expect(parsed.content[0]).toMatchObject({ type: 'callout', attrs: { variant: 'info' } });
  });

  it('parses a plain details element (importers emit these) into summary and content', () => {
    const parsed = generateJSON('<details><summary>More</summary><p>Hidden</p></details>',
      wikiExtensions());
    expect(parsed.content[0]).toEqual({
      type: 'details',
      content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: 'Hidden' }] }],
        },
      ],
    });
  });

  it('parses a bare image figure (importers emit these) with empty alt and caption', () => {
    const parsed = generateJSON(`<figure data-wiki-image="${FIXTURE_IMAGE_ASSET}"></figure>`,
      wikiExtensions());
    expect(parsed.content[0]).toEqual({
      type: 'wikiImage',
      attrs: { assetId: FIXTURE_IMAGE_ASSET, alt: '', caption: '', width: null },
    });
  });
});

describe('wikiExtensions: options', () => {
  const names = (exts: ReturnType<typeof wikiExtensions>) => exts.map((e) => e.name);

  it('keeps local undo history and no collaboration by default', () => {
    const exts = wikiExtensions();
    expect(names(exts)).not.toContain('collaboration');
    expect(names(exts)).not.toContain('collaborationCursor');
    expect(names(exts)).not.toContain('placeholder');
    const kit = exts.find((e) => e.name === 'starterKit');
    expect(kit?.options.history).not.toBe(false);
  });

  it('switches to Yjs history and adds cursors when collaborating', () => {
    const doc = new Y.Doc();
    const exts = wikiExtensions({
      collab: { doc, provider: { awareness: null }, user: { name: 'Ada', color: '#ff8800' } },
      placeholder: 'Start writing',
    });
    expect(names(exts)).toEqual(expect.arrayContaining(
      ['collaboration', 'collaborationCursor', 'placeholder']));
    expect(exts.find((e) => e.name === 'starterKit')?.options.history).toBe(false);
    expect(exts.find((e) => e.name === 'collaboration')?.options.document).toBe(doc);
    // the wiki server stores and seeds this same Y.Doc field
    expect(exts.find((e) => e.name === 'collaboration')?.options.field).toBe('default');
  });

  it('builds a schema with the custom node types', () => {
    const schema = getSchema(wikiExtensions());
    expect(Object.keys(schema.nodes)).toEqual(expect.arrayContaining(
      ['callout', 'wikiImage', 'fileEmbed', 'pageLink', 'table', 'taskList', 'codeBlock',
        'details', 'detailsSummary', 'detailsContent']));
    expect(schema.nodes.pageLink.isInline).toBe(true);
    expect(schema.nodes.pageLink.isAtom).toBe(true);
    expect(schema.nodes.wikiImage.isAtom).toBe(true);
    expect(schema.nodes.fileEmbed.isAtom).toBe(true);
  });
});
