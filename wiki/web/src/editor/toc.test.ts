import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { buildToc, headingIdsOf, sectionHashTarget, sectionLinkTarget, slugify } from './toc';
import { wikiExtensions } from './schema';

const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level, textAlign: null },
  content: text ? [{ type: 'text', text }] : [],
});

const doc = {
  type: 'doc',
  content: [
    heading(1, 'Rack power runbook'),
    { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
    heading(2, 'Before you start'),
    heading(2, 'Before you start'),
    {
      type: 'callout',
      attrs: { variant: 'info' },
      content: [heading(3, 'Nested: PDU A/B')],
    },
    heading(2, ''),
    heading(3, 'Étape — finale!'),
  ],
};

describe('slugify', () => {
  it('lowercases, drops punctuation and joins words with dashes', () => {
    expect(slugify('Before you start')).toBe('before-you-start');
    expect(slugify('  Nested: PDU A/B  ')).toBe('nested-pdu-a-b');
    expect(slugify('Étape — finale!')).toBe('etape-finale');
  });

  it('falls back to "section" when nothing is left', () => {
    expect(slugify('')).toBe('section');
    expect(slugify('!!!')).toBe('section');
  });
});

describe('buildToc', () => {
  // ids carry an "h-" prefix so a heading can never reuse an app element's id ("root")
  it('lists every heading in document order, nested ones included', () => {
    expect(buildToc(doc)).toEqual([
      { level: 1, text: 'Rack power runbook', id: 'h-rack-power-runbook' },
      { level: 2, text: 'Before you start', id: 'h-before-you-start' },
      { level: 2, text: 'Before you start', id: 'h-before-you-start-2' },
      { level: 3, text: 'Nested: PDU A/B', id: 'h-nested-pdu-a-b' },
      { level: 3, text: 'Étape — finale!', id: 'h-etape-finale' },
    ]);
  });

  it('is empty for an empty or missing document', () => {
    expect(buildToc({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
    expect(buildToc(null)).toEqual([]);
  });

  it('gives the ProseMirror document the same ids (the editor decorates with them)', () => {
    const pm = PMNode.fromJSON(getSchema(wikiExtensions()), doc);
    expect(headingIdsOf(pm).map((h) => h.id)).toEqual(buildToc(doc).map((t) => t.id));
  });

  it('reads a mention in a heading as @label, same in both walks', () => {
    const mentioned = {
      type: 'doc',
      content: [{
        type: 'heading',
        attrs: { level: 2, textAlign: null },
        content: [
          { type: 'text', text: 'Owner: ' },
          { type: 'mention', attrs: { personId: 'p-1', label: 'Pat Doe' } },
        ],
      }],
    };
    expect(buildToc(mentioned)).toEqual([{ level: 2, text: 'Owner: @Pat Doe', id: 'h-owner-pat-doe' }]);
    const pm = PMNode.fromJSON(getSchema(wikiExtensions()), mentioned);
    expect(headingIdsOf(pm).map((h) => h.id)).toEqual(['h-owner-pat-doe']);
  });

  it('never reads a page link\'s stored title (it may be stale or private), same in both walks', () => {
    const linked = {
      type: 'doc',
      content: [{
        type: 'heading',
        attrs: { level: 2, textAlign: null },
        content: [
          { type: 'text', text: 'See ' },
          { type: 'pageLink', attrs: { nodeId: 'n-1', title: 'Secret merger plan' } },
        ],
      }],
    };
    const toc = buildToc(linked);
    expect(toc).toEqual([{ level: 2, text: 'See page', id: 'h-see-page' }]);
    const pm = PMNode.fromJSON(getSchema(wikiExtensions()), linked);
    expect(headingIdsOf(pm).map((h) => h.id)).toEqual(['h-see-page']);
  });
});

describe('section links', () => {
  const PAGE = '99e015d8-3319-4ada-9582-b9d979567fde';

  it('reads the heading id from a link to this page', () => {
    expect(sectionLinkTarget(`/n/${PAGE}#h-the-bulk-way`, PAGE)).toBe('h-the-bulk-way');
    expect(sectionLinkTarget(`/n/${PAGE.toUpperCase()}#h-step-2-2`, PAGE)).toBe('h-step-2-2');
  });

  it('is null for another page, a plain page link, or a hash that is not a heading', () => {
    expect(sectionLinkTarget(`/n/4fa04d95-6bb6-470c-80fb-ffb77a80651a#h-x`, PAGE)).toBeNull();
    expect(sectionLinkTarget(`/n/${PAGE}`, PAGE)).toBeNull();
    expect(sectionLinkTarget(`/n/${PAGE}#comment-abc`, PAGE)).toBeNull();
    expect(sectionLinkTarget('https://example.com/#h-x', PAGE)).toBeNull();
  });

  it('reads the heading id from a location hash', () => {
    expect(sectionHashTarget('#h-troubleshooting')).toBe('h-troubleshooting');
    expect(sectionHashTarget('#comment-abc')).toBeNull();
    expect(sectionHashTarget('')).toBeNull();
  });
});
