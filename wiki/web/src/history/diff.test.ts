import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { diffDocs, flattenBlocks } from './diff';

const text = (t: string): JSONContent => ({ type: 'text', text: t });
const p = (t: string): JSONContent => ({ type: 'paragraph', content: t ? [text(t)] : [] });
const h = (level: number, t: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const li = (t: string): JSONContent => ({ type: 'listItem', content: [p(t)] });
const ul = (...items: string[]): JSONContent => ({ type: 'bulletList', content: items.map(li) });
const cell = (t: string): JSONContent => ({ type: 'tableCell', content: [p(t)] });
const row = (...cells: string[]): JSONContent => ({ type: 'tableRow', content: cells.map(cell) });
const table = (...rows: string[][]): JSONContent => ({ type: 'table', content: rows.map((r) => row(...r)) });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const ops = (a: JSONContent, b: JSONContent) => diffDocs(a, b).map((d) => d.op);

describe('flattenBlocks', () => {
  it('makes each top-level block, list item and table row its own block', () => {
    const blocks = flattenBlocks(doc(
      h(2, 'Before  you start'),
      ul('Power off', 'Label cables'),
      table(['Rack', 'Owner'], ['R12', 'Ops']),
      p('Done.'),
    ));
    expect(blocks.map((b) => [b.type, b.text])).toEqual([
      ['heading', 'Before you start'],
      ['listItem', 'Power off'],
      ['listItem', 'Label cables'],
      ['tableRow', 'Rack | Owner'],
      ['tableRow', 'R12 | Ops'],
      ['paragraph', 'Done.'],
    ]);
    // the key is the type plus the normalized text
    expect(blocks[0].key).toContain('heading');
    expect(blocks[0].key).toContain('Before you start');
    expect(blocks[1].json).toEqual(li('Power off'));
  });

  it('tells apart text-less blocks by their attributes', () => {
    const img = (assetId: string): JSONContent => ({ type: 'wikiImage', attrs: { assetId, alt: '', caption: '' } });
    const [a, b] = flattenBlocks(doc(img('a-1'), img('a-2')));
    expect(a.key).not.toBe(b.key);
  });

  it('is empty for a missing document', () => {
    expect(flattenBlocks(null)).toEqual([]);
  });
});

describe('diffDocs', () => {
  it('marks everything the same for identical docs', () => {
    const d = doc(h(1, 'Title'), p('One'), ul('A', 'B'));
    expect(ops(d, d)).toEqual(['same', 'same', 'same', 'same']);
  });

  it('finds an inserted paragraph', () => {
    const result = diffDocs(doc(p('One'), p('Three')), doc(p('One'), p('Two'), p('Three')));
    expect(result.map((d) => d.op)).toEqual(['same', 'add', 'same']);
    expect(result[1].b?.text).toBe('Two');
    expect(result[1].a).toBeUndefined();
  });

  it('finds a removed list item', () => {
    const result = diffDocs(doc(ul('Power off', 'Unplug', 'Label')), doc(ul('Power off', 'Label')));
    expect(result.map((d) => d.op)).toEqual(['same', 'remove', 'same']);
    expect(result[1].a?.text).toBe('Unplug');
  });

  it('pairs a word change inside a paragraph as a change with a word diff', () => {
    const result = diffDocs(
      doc(p('Intro'), p('Turn off the rack power first.')),
      doc(p('Intro'), p('Turn off the PDU power first.')),
    );
    expect(result.map((d) => d.op)).toEqual(['same', 'change']);
    const words = result[1].words ?? [];
    expect(words.filter((w) => w.op === 'remove').map((w) => w.text.trim())).toEqual(['rack']);
    expect(words.filter((w) => w.op === 'add').map((w) => w.text.trim())).toEqual(['PDU']);
    expect(words.map((w) => (w.op === 'remove' ? '' : w.text)).join('')).toBe('Turn off the PDU power first.');
  });

  it('shows a changed table row as a change', () => {
    const result = diffDocs(
      doc(table(['Rack', 'Owner'], ['R12', 'Ops'])),
      doc(table(['Rack', 'Owner'], ['R12', 'Field'])),
    );
    expect(result.map((d) => d.op)).toEqual(['same', 'change']);
    expect(result[1].a?.type).toBe('tableRow');
    expect(result[1].words?.some((w) => w.op === 'add' && w.text.includes('Field'))).toBe(true);
  });

  it('never pairs blocks of different types', () => {
    expect(ops(doc(p('Old words')), doc(h(2, 'New words')))).toEqual(['remove', 'add']);
  });
});
