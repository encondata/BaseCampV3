/** A block-level diff between two versions of a page, computed in the
 *  browser: each document is flattened to blocks (top-level blocks, with
 *  list items and table rows as blocks of their own) keyed by type and
 *  normalized text, an LCS over the keys finds what stayed, and a removed
 *  block followed by an added block of the same type becomes a `change`
 *  with a word diff inside it. */
import type { JSONContent } from '@tiptap/core';
import { diffWordsWithSpace } from 'diff';

export interface Block {
  /** Type (and heading level) plus the normalized text — equal keys are "the same block". */
  key: string;
  type: string;
  text: string;
  json: JSONContent;
}

export type WordOp = 'same' | 'add' | 'remove';

export interface DiffWord {
  op: WordOp;
  text: string;
}

export interface DiffBlock {
  op: 'same' | 'add' | 'remove' | 'change';
  /** The block in the older document (same, remove, change). */
  a?: Block;
  /** The block in the newer document (same, add, change). */
  b?: Block;
  /** For a change: the text, word by word. */
  words?: DiffWord[];
}

const SPLIT_INTO_ITEMS = new Set(['bulletList', 'orderedList', 'taskList']);
const INLINE = new Set(['text', 'hardBreak', 'pageLink', 'mention']);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Readable text of a node. Stored link titles and file names are never
 *  used (they may be stale or name something the reader can't see); a
 *  mention's label is (only people who can view the page are mentioned). */
function textOf(node: JSONContent): string {
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return ' ';
    case 'pageLink': return '[page link]';
    case 'mention': return `@${String(node.attrs?.label ?? '')}`;
    case 'fileEmbed': return '[file]';
    case 'wikiImage': return String(node.attrs?.caption || node.attrs?.alt || '[image]');
    case 'horizontalRule': return '———';
    case 'tableRow': return (node.content ?? []).map((c) => normalize(textOf(c))).join(' | ');
    default: {
      const kids = node.content ?? [];
      const inline = kids.some((k) => INLINE.has(k.type ?? ''));
      return kids.map(textOf).join(inline ? '' : ' ');
    }
  }
}

/** Attributes in a stable order, so equal attributes give equal keys. */
function stableAttrs(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return '';
  return JSON.stringify(Object.keys(attrs).sort().map((k) => [k, attrs[k]]));
}

function toBlock(node: JSONContent): Block {
  const type = node.type ?? 'unknown';
  const text = normalize(textOf(node));
  const level = type === 'heading' ? `:${String(node.attrs?.level ?? '')}` : '';
  // a block with no content (an image, a divider) is told apart by its attributes
  const body = node.content?.length ? text : `${text}${stableAttrs(node.attrs)}`;
  return { key: `${type}${level}|${body}`, type, text, json: node };
}

export function flattenBlocks(doc: JSONContent | null | undefined): Block[] {
  const out: Block[] = [];
  for (const node of doc?.content ?? []) {
    if (SPLIT_INTO_ITEMS.has(node.type ?? '')) {
      for (const item of node.content ?? []) out.push(toBlock(item));
    } else if (node.type === 'table') {
      for (const row of node.content ?? []) out.push(toBlock(row));
    } else {
      out.push(toBlock(node));
    }
  }
  return out;
}

type Step = { op: 'same'; a: Block; b: Block } | { op: 'remove'; a: Block } | { op: 'add'; b: Block };

/** Longest common subsequence over block keys, as same/remove/add steps. */
function lcsSteps(a: Block[], b: Block[]): Step[] {
  // equal ends need no table
  let start = 0;
  while (start < a.length && start < b.length && a[start].key === b[start].key) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1].key === b[endB - 1].key) { endA -= 1; endB -= 1; }

  const n = endA - start;
  const m = endB - start;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[start + i].key === b[start + j].key
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const steps: Step[] = [];
  for (let k = 0; k < start; k += 1) steps.push({ op: 'same', a: a[k], b: b[k] });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i].key === b[start + j].key) {
      steps.push({ op: 'same', a: a[start + i], b: b[start + j] });
      i += 1; j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      steps.push({ op: 'remove', a: a[start + i] });
      i += 1;
    } else {
      steps.push({ op: 'add', b: b[start + j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) steps.push({ op: 'remove', a: a[start + i] });
  for (; j < m; j += 1) steps.push({ op: 'add', b: b[start + j] });
  for (let k = 0; k < a.length - endA; k += 1) steps.push({ op: 'same', a: a[endA + k], b: b[endB + k] });
  return steps;
}

export function wordDiff(a: string, b: string): DiffWord[] {
  return diffWordsWithSpace(a, b).map((c) => ({
    op: c.added ? 'add' : c.removed ? 'remove' : 'same',
    text: c.value,
  }));
}

/** Within a run of removes and adds, a removed block and the next unpaired
 *  added block of the same type become one change. */
function pairRun(run: Step[]): DiffBlock[] {
  const partner = new Map<Step, Step>();
  const taken = new Set<Step>();
  for (const r of run) {
    if (r.op !== 'remove') continue;
    const match = run.find((s) => s.op === 'add' && !taken.has(s) && s.b.type === r.a.type);
    if (match) { partner.set(r, match); taken.add(match); }
  }
  const out: DiffBlock[] = [];
  for (const s of run) {
    if (s.op === 'remove') {
      const add = partner.get(s);
      if (add && add.op === 'add') {
        out.push({ op: 'change', a: s.a, b: add.b, words: wordDiff(s.a.text, add.b.text) });
      } else {
        out.push({ op: 'remove', a: s.a });
      }
    } else if (s.op === 'add' && !taken.has(s)) {
      out.push({ op: 'add', b: s.b });
    }
  }
  return out;
}

/** The blocks of `a` (older) and `b` (newer), in order, each marked same /
 *  add / remove / change. */
export function diffDocs(a: JSONContent | null | undefined, b: JSONContent | null | undefined): DiffBlock[] {
  const steps = lcsSteps(flattenBlocks(a), flattenBlocks(b));
  const out: DiffBlock[] = [];
  let run: Step[] = [];
  const flush = () => { if (run.length) { out.push(...pairRun(run)); run = []; } };
  for (const s of steps) {
    if (s.op === 'same') {
      flush();
      out.push({ op: 'same', a: s.a, b: s.b });
    } else {
      run.push(s);
    }
  }
  flush();
  return out;
}
