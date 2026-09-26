// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listComments: vi.fn(),
}));

import type { CommentOut, CommentThread } from '../lib/types';
import { listComments } from '../lib/wikiApi';
import { makeSpace } from '../testing/fixtures';
import {
  arrangeThreads, canCommentOn, canDeleteComment, canResolveThread, commentLinkTarget, mentionSegments,
  mentionsIn, POLL_MS, quoteSelection, useCommentThreads,
} from './commentsStore';

const ada = { id: 'p-2', name: 'Ada Lovelace' };
const me = { id: 'p-1', name: 'Jimmy Henderson' };

function comment(id: string, over: Partial<CommentOut> = {}): CommentOut {
  return {
    id, thread_id: over.thread_id ?? id, parent_id: null, body: { text: `text ${id}`, mentions: [] },
    author: me, created_at: '2026-09-20T10:00:00Z', edited_at: null, deleted: false, ...over,
  };
}

function thread(id: string, over: Partial<CommentThread> & { at?: string; author?: typeof me } = {}): CommentThread {
  const { at, author, ...rest } = over;
  return {
    thread_id: id, anchor: false, resolved_at: null, resolved_by: null,
    comments: [comment(id, { created_at: at ?? '2026-09-20T10:00:00Z', author: author ?? me })],
    ...rest,
  };
}

describe('who may do what', () => {
  it('lets editors comment, and readers while the space allows it', () => {
    const space = makeSpace();
    expect(canCommentOn('edit', space)).toBe(true);
    expect(canCommentOn('manage', space)).toBe(true);
    expect(canCommentOn('view', space)).toBe(true);                     // the default is on
    expect(canCommentOn('view', makeSpace({ settings: { readers_can_comment: false } }))).toBe(false);
    expect(canCommentOn('view', makeSpace({ archived_at: '2026-09-01T00:00:00Z' }))).toBe(false);
    expect(canCommentOn(null, space)).toBe(false);
  });

  it('resolves for editors and the thread\'s author; deletes your own, or any as a manager', () => {
    const mine = thread('t1');
    const theirs = thread('t2', { author: ada });
    expect(canResolveThread(theirs, 'edit', me.id)).toBe(true);
    expect(canResolveThread(mine, 'view', me.id)).toBe(true);
    expect(canResolveThread(theirs, 'view', me.id)).toBe(false);
    expect(canDeleteComment(mine.comments[0], 'view', me.id)).toBe(true);
    expect(canDeleteComment(theirs.comments[0], 'edit', me.id)).toBe(false);
    expect(canDeleteComment(theirs.comments[0], 'manage', me.id)).toBe(true);
    expect(canDeleteComment({ ...mine.comments[0], deleted: true }, 'manage', me.id)).toBe(false);
  });

  it('takes the thread\'s author from the first comment that still names one', () => {
    const anonymousRoot = { ...thread('t3'), comments: [
      comment('t3', { author: null, deleted: true }), comment('c4', { thread_id: 't3', author: me }),
    ] };
    expect(canResolveThread(anonymousRoot, 'view', me.id)).toBe(true);
    expect(canResolveThread(anonymousRoot, 'view', ada.id)).toBe(false);
  });
});

describe('arrangeThreads', () => {
  const inlineA = thread('a', { anchor: true, at: '2026-09-20T09:00:00Z' });
  const inlineB = thread('b', { anchor: true, at: '2026-09-20T08:00:00Z' });
  const gone = thread('gone', { anchor: true });
  const pageOld = thread('p-old', { at: '2026-09-19T10:00:00Z' });
  const pageNew = thread('p-new', { at: '2026-09-21T10:00:00Z' });
  const resolvedInline = thread('r', { anchor: true, resolved_at: '2026-09-22T00:00:00Z', resolved_by: ada });
  const resolvedPage = thread('rp', { resolved_at: '2026-09-22T00:00:00Z', resolved_by: ada, at: '2026-09-18T00:00:00Z' });

  it('orders inline threads by where their text is, then page threads by date', () => {
    const anchors = new Map([['a', { pos: 40, text: 'spare PDU' }], ['b', { pos: 3, text: 'rack' }],
      ['r', { pos: 1, text: 'first' }]]);
    const out = arrangeThreads([pageNew, inlineA, resolvedPage, gone, pageOld, inlineB, resolvedInline], anchors);
    expect(out.open.map((t) => t.thread_id)).toEqual(['b', 'a', 'p-old', 'p-new']);
    expect(out.elsewhere.map((t) => t.thread_id)).toEqual(['gone']);
    expect(out.resolved.map((t) => t.thread_id)).toEqual(['r', 'rp']);
    expect(out.openCount).toBe(5);
  });

  it('keeps inline threads in date order until the document is read', () => {
    const out = arrangeThreads([inlineA, pageOld, inlineB], null);
    expect(out.open.map((t) => t.thread_id)).toEqual(['p-old', 'b', 'a']);
    expect(out.elsewhere).toEqual([]);
  });
});

describe('text helpers', () => {
  it('quotes a selection on one line, at most 200 characters', () => {
    expect(quoteSelection('  spare\n PDU  ')).toBe('> "spare PDU"\n\n');
    const long = quoteSelection('x'.repeat(500));
    const inner = long.slice(3, long.indexOf('"\n'));
    expect(inner.length).toBe(200);
    expect(inner.endsWith('…')).toBe(true);
  });

  it('splits a body into text and @mention chips', () => {
    const grace = { id: 'p-3', name: 'Grace' };
    const graceH = { id: 'p-4', name: 'Grace Hopper' };
    expect(mentionSegments('Ping @Grace Hopper and @Grace, not @Bob', [grace, graceH])).toEqual([
      { text: 'Ping ' }, { person: graceH }, { text: ' and ' }, { person: grace }, { text: ', not @Bob' },
    ]);
    expect(mentionSegments('plain', [])).toEqual([{ text: 'plain' }]);
  });

  it('keeps only the picked people still named in the text', () => {
    expect(mentionsIn('Thanks @Ada Lovelace!', [ada, me])).toEqual(['p-2']);
    expect(mentionsIn('@Ada Lovelace @Ada Lovelace', [ada, ada])).toEqual(['p-2']);
  });

  it('reads a comment deep link', () => {
    expect(commentLinkTarget('#comment-abc')).toBe('abc');
    expect(commentLinkTarget('#h-intro')).toBeNull();
    expect(commentLinkTarget('')).toBeNull();
  });
});

describe('useCommentThreads', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.mocked(listComments).mockReset().mockResolvedValue([thread('t1')]);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const flush = () => act(async () => { await Promise.resolve(); });

  it('loads once, and polls every 20 s only while asked to and visible', async () => {
    const { result, rerender } = renderHook(({ poll }) => useCommentThreads('p1', { poll }), {
      initialProps: { poll: false },
    });
    await flush();
    expect(result.current.threads?.map((t) => t.thread_id)).toEqual(['t1']);
    expect(listComments).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
    expect(listComments).toHaveBeenCalledTimes(1);

    rerender({ poll: true });
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    expect(listComments).toHaveBeenCalledTimes(2);

    // a hidden tab doesn't poll; coming back refreshes at once
    visibility = 'hidden';
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
    expect(listComments).toHaveBeenCalledTimes(2);
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(listComments).toHaveBeenCalledTimes(3);
  });

  it('refreshes on demand and keeps the newest answer', async () => {
    const { result } = renderHook(() => useCommentThreads('p1', { poll: false }));
    await flush();
    let resolveSlow: (v: CommentThread[]) => void = () => {};
    vi.mocked(listComments)
      .mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }))
      .mockResolvedValueOnce([thread('new')]);
    let first: Promise<CommentThread[] | null> = Promise.resolve(null);
    let second: Promise<CommentThread[] | null> = Promise.resolve(null);
    await act(async () => { first = result.current.refresh(); second = result.current.refresh(); });
    await flush();
    resolveSlow([thread('stale')]);
    await flush();
    expect(result.current.threads?.map((t) => t.thread_id)).toEqual(['new']);
    // each caller still hears what its own request found
    expect((await first)?.map((t) => t.thread_id)).toEqual(['stale']);
    expect((await second)?.map((t) => t.thread_id)).toEqual(['new']);
    vi.mocked(listComments).mockRejectedValueOnce(new Error('offline'));
    let failed: Promise<CommentThread[] | null> = Promise.resolve([]);
    await act(async () => { failed = result.current.refresh(); });
    expect(await failed).toBeNull();
  });

  it('fetches nothing until enabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useCommentThreads('p1', { enabled, poll: true }), {
      initialProps: { enabled: false },
    });
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
    expect(listComments).not.toHaveBeenCalled();
    expect(result.current.threads).toBeNull();
    rerender({ enabled: true });
    await flush();
    expect(listComments).toHaveBeenCalledTimes(1);
    expect(result.current.threads?.map((t) => t.thread_id)).toEqual(['t1']);
  });
});
