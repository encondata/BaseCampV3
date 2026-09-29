// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor, type JSONContent } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  postComment: vi.fn(),
  listMentionable: vi.fn(),
}));

import { wikiExtensions } from '../editor/schema';
import type { CommentOut, CommentThread } from '../lib/types';
import { postComment } from '../lib/wikiApi';
import { captureSelection, threadAnchors } from './commentMarks';
import CommentsRail, { ReaderCommentBubble, type CommentsRailProps, type NewComment } from './CommentsRail';

const me = { id: 'p-1', name: 'Jimmy Henderson' };

function thread(id: string, over: Partial<CommentThread> = {}, at = '2026-09-20T10:00:00Z'): CommentThread {
  const c: CommentOut = { id, thread_id: id, parent_id: null, body: { text: `about ${id}`, mentions: [] },
    author: me, created_at: at, edited_at: null, deleted: false };
  return { thread_id: id, anchor: false, resolved_at: null, resolved_by: null, comments: [c], ...over };
}

const refresh = vi.fn<() => Promise<CommentThread[] | null>>();
const onNewComment = vi.fn<(next: NewComment | null) => void>();
const onFocusThread = vi.fn();

beforeEach(() => {
  toast.mockReset();
  refresh.mockReset().mockResolvedValue([]);
  onNewComment.mockReset();
  onFocusThread.mockReset();
  vi.mocked(postComment).mockReset().mockResolvedValue({ thread_id: 'new-t' } as CommentOut);
});
afterEach(cleanup);

function renderRail(over: Partial<CommentsRailProps> = {}) {
  const props: CommentsRailProps = {
    pageId: 'page-1', mode: 'view', level: 'edit', meId: me.id, canComment: true, threads: [], error: null,
    anchors: new Map(), editor: null, focusedThread: null, targetCommentId: null,
    onFocusThread, onHoverThread: () => {}, newComment: null, onNewComment, refresh, onThreadGone: () => {},
    ...over,
  };
  return render(<CommentsRail {...props} />);
}

/** The text of each thread's first comment, in the order shown. */
const shown = (root: HTMLElement = document.body) => Array.from(root.querySelectorAll('.wiki-thread .wiki-comment-body'))
  .map((el) => el.textContent);

describe('CommentsRail — arranging', () => {
  const threads = [
    thread('page-later', {}, '2026-09-21T10:00:00Z'),
    thread('inline-2', { anchor: true }),
    thread('gone', { anchor: true }),
    thread('page-early', {}, '2026-09-19T10:00:00Z'),
    thread('inline-1', { anchor: true }),
    thread('done', { resolved_at: '2026-09-22T00:00:00Z', resolved_by: me }),
  ];
  const anchors = new Map([['inline-1', { pos: 2, text: 'rack' }], ['inline-2', { pos: 30, text: 'spare PDU' }]]);

  it('lists inline threads by their text, page threads by date, then the rest', () => {
    renderRail({ threads, anchors });
    expect(shown()).toEqual(['about inline-1', 'about inline-2', 'about page-early', 'about page-later', 'about gone']);
    expect(screen.getByText('spare PDU').tagName).toBe('BLOCKQUOTE');
    expect(screen.getByText('On text not in this version (1)')).toBeTruthy();

    // resolved threads wait behind their toggle
    const toggle = screen.getByRole('button', { name: 'Resolved (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(shown()).toContain('about done');
  });

  it('calls text missing from the live document deleted, in edit mode', () => {
    renderRail({ threads, anchors, mode: 'edit' });
    expect(screen.getByText('On deleted text (1)')).toBeTruthy();
  });

  it('opens the resolved list for a thread picked elsewhere', () => {
    renderRail({ threads, anchors, focusedThread: 'done' });
    expect(screen.getByRole('button', { name: 'Resolved (1)' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('#thread-done')!.className).toContain('is-focused');
  });

  it('says when there is nothing yet, and loads first', () => {
    renderRail({ threads: null });
    expect(screen.getByText('Loading comments…')).toBeTruthy();
    cleanup();
    renderRail({ threads: [] });
    expect(screen.getByText(/No comments yet/)).toBeTruthy();
  });

  it('offers no new comments to people who can\'t comment', () => {
    renderRail({ threads, anchors, canComment: false, level: 'view' });
    expect(screen.queryByRole('button', { name: 'New comment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});

describe('CommentsRail — starting a thread', () => {
  const post = async (text: string) => {
    fireEvent.change(document.querySelector('textarea')!, { target: { value: text } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Comment' })); });
  };

  it('starts a page-level thread from New comment', async () => {
    const { rerender } = renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New comment' }));
    expect(onNewComment).toHaveBeenCalledWith({ kind: 'page' });
    const props = {
      pageId: 'page-1', mode: 'view' as const, level: 'edit' as const, meId: me.id, canComment: true, threads: [],
      error: null, anchors: new Map(), editor: null, focusedThread: null, targetCommentId: null, onFocusThread,
      onHoverThread: () => {}, newComment: { kind: 'page' as const }, onNewComment, refresh, onThreadGone: () => {},
    };
    rerender(<CommentsRail {...props} />);
    expect(screen.getByRole('textbox', { name: 'New comment' })).toBeTruthy();
    await post('General question');
    expect(postComment).toHaveBeenCalledWith('page-1', { body: { text: 'General question', mentions: [] } });
    expect(onNewComment).toHaveBeenLastCalledWith(null);
    expect(onFocusThread).toHaveBeenCalledWith('new-t');
    expect(refresh).toHaveBeenCalled();
  });

  it('quotes a reader\'s selection at the start of a page-level thread', async () => {
    renderRail({ newComment: { kind: 'quote', text: 'the spare\nPDU' }, level: 'view' });
    expect(screen.getByText('the spare PDU').tagName).toBe('BLOCKQUOTE');
    await post('Which one?');
    expect(postComment).toHaveBeenCalledWith('page-1', {
      body: { text: '> "the spare PDU"\n\nWhich one?', mentions: [] },
    });
  });

  it('keeps an unsent draft when the selection it quotes changes', () => {
    const onDraftChange = vi.fn();
    const { rerender } = renderRail({ newComment: { kind: 'quote', text: 'first bit' }, onDraftChange });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'half-written' } });
    expect(onDraftChange).toHaveBeenLastCalledWith(true);
    rerender(<CommentsRail pageId="page-1" mode="view" level="edit" meId={me.id} canComment threads={[]} error={null}
                           anchors={new Map()} editor={null} focusedThread={null} targetCommentId={null}
                           onFocusThread={onFocusThread} onHoverThread={() => {}}
                           newComment={{ kind: 'quote', text: 'second bit' }} onNewComment={onNewComment}
                           onDraftChange={onDraftChange} refresh={refresh} onThreadGone={() => {}} />);
    expect(screen.getByText('second bit').tagName).toBe('BLOCKQUOTE');
    expect(document.querySelector('textarea')!.value).toBe('half-written');
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '  ' } });
    expect(onDraftChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the composer when posting is refused', async () => {
    vi.mocked(postComment).mockRejectedValueOnce(new Error('offline'));
    renderRail({ newComment: { kind: 'page' } });
    await post('Hello');
    expect(toast).toHaveBeenCalledWith('Couldn\'t post your comment.');
    expect(onNewComment).not.toHaveBeenCalledWith(null);
    expect(document.querySelector('textarea')!.value).toBe('Hello');
  });

  describe('on text, in the live editor', () => {
    let editor: Editor;
    beforeEach(() => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      editor = new Editor({ element: el, extensions: wikiExtensions(), content: '<p>Check the spare PDU stock.</p>' });
    });
    afterEach(() => { editor.destroy(); document.body.replaceChildren(); });

    const marked = () => (editor.getJSON().content?.[0].content ?? [])
      .filter((n: JSONContent) => n.marks?.some((m) => m.type === 'commentThread'))
      .map((n: JSONContent) => [n.text, n.marks?.find((m) => m.type === 'commentThread')?.attrs?.threadId]);

    it('posts an inline thread and anchors it to the selection', async () => {
      editor.commands.setTextSelection({ from: 11, to: 20 });
      const captured = captureSelection(editor)!;
      editor.commands.setTextSelection(1);        // the caret moved on meanwhile
      renderRail({ mode: 'edit', editor, newComment: { kind: 'inline', captured } });
      await post('Which one?');
      expect(postComment).toHaveBeenCalledWith('page-1', { body: { text: 'Which one?', mentions: [] }, anchor: true });
      expect(marked()).toEqual([['spare PDU', 'new-t']]);
      expect([...threadAnchors(editor.state.doc).keys()]).toEqual(['new-t']);
      expect(toast).not.toHaveBeenCalled();
    });

    it('falls back to a page-level thread quoting the text when it was removed', async () => {
      editor.commands.setTextSelection({ from: 11, to: 20 });
      const captured = captureSelection(editor)!;
      editor.commands.deleteRange({ from: 11, to: 20 });
      renderRail({ mode: 'edit', editor, newComment: { kind: 'inline', captured } });
      await post('Which one?');
      expect(postComment).toHaveBeenCalledWith('page-1', {
        body: { text: '> "spare PDU"\n\nWhich one?', mentions: [] },
      });
      expect(marked()).toEqual([]);
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/was removed meanwhile/));
    });
  });
});

describe('ReaderCommentBubble', () => {
  function Host({ onComment }: { onComment: (text: string) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={ref}><p>Readers can quote this sentence.</p></div>
        <p>Outside the page.</p>
        <ReaderCommentBubble container={ref} onComment={onComment} />
      </>
    );
  }

  const selectText = (text: string) => {
    const node = screen.getByText(text).firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 7);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it('offers Comment for text selected in the page only', async () => {
    vi.useFakeTimers();
    try {
      const onComment = vi.fn();
      render(<Host onComment={onComment} />);
      selectText('Outside the page.');
      await act(async () => { fireEvent.mouseUp(document); vi.runAllTimers(); });
      expect(screen.queryByRole('toolbar')).toBeNull();

      selectText('Readers can quote this sentence.');
      await act(async () => { fireEvent.mouseUp(document); vi.runAllTimers(); });
      fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Comment' }));
      expect(onComment).toHaveBeenCalledWith('Readers');
      expect(screen.queryByRole('toolbar')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
