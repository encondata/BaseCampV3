import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { buildToc, headingIdsOf, slugify } from './toc';
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
});
