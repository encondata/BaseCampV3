// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  postComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  resolveThread: vi.fn(),
  reopenThread: vi.fn(),
  listMentionable: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import type { CommentOut, CommentThread, Level } from '../lib/types';
import { deleteComment, editComment, postComment, reopenThread, resolveThread } from '../lib/wikiApi';
import Thread from './Thread';

const me = { id: 'p-1', name: 'Jimmy Henderson' };
const ada = { id: 'p-2', name: 'Ada Lovelace' };

function comment(id: string, over: Partial<CommentOut> = {}): CommentOut {
  return {
    id, thread_id: 't1', parent_id: id === 't1' ? null : 't1', body: { text: `text ${id}`, mentions: [] },
    author: me, created_at: new Date(Date.now() - 3600_000).toISOString(), edited_at: null, deleted: false, ...over,
  };
}

const onChanged = vi.fn<() => Promise<void>>();
const onGone = vi.fn();
const onFocus = vi.fn();
const onHover = vi.fn();

beforeEach(() => {
  toast.mockReset();
  onChanged.mockReset().mockResolvedValue(undefined);
  onGone.mockReset();
  onFocus.mockReset();
  onHover.mockReset();
  for (const fn of [postComment, editComment, deleteComment, resolveThread, reopenThread]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined as never);
  }
});
afterEach(cleanup);

function renderThread(thread: CommentThread, opts: { level?: Level; canComment?: boolean; anchorText?: string } = {}) {
  return render(
    <Thread pageId="page-1" thread={thread} anchorText={opts.anchorText} level={opts.level ?? 'edit'} meId={me.id}
            canComment={opts.canComment ?? true} focused={false} onFocus={onFocus} onHover={onHover}
            onChanged={onChanged} onGone={onGone} />,
  );
}

const THREAD: CommentThread = {
  thread_id: 't1', anchor: true, resolved_at: null, resolved_by: null,
  comments: [
    comment('t1', { author: ada, body: { text: 'Is @Jimmy Henderson on this?\nSecond line', mentions: [me] },
      edited_at: new Date().toISOString() }),
    comment('c2', { body: { text: 'On it.', mentions: [] } }),
  ],
};

describe('Thread', () => {
  it('shows the anchored text and each comment as plain text with mention chips', () => {
    renderThread(THREAD, { anchorText: 'spare PDU' });
    expect(screen.getByText('spare PDU').tagName).toBe('BLOCKQUOTE');
    const first = document.getElementById('comment-t1')!;
    expect(within(first).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(first).getByText(/1h ago · edited/)).toBeTruthy();
    expect(within(first).getByText('@Jimmy Henderson').className).toBe('wiki-mention');
    expect(first.querySelector('.wiki-comment-body')!.textContent).toBe('Is @Jimmy Henderson on this?\nSecond line');
  });

  it('offers edit and delete on your own comments only (delete on any, as a manager)', () => {
    renderThread(THREAD);
    const theirs = document.getElementById('comment-t1')!;
    const mine = document.getElementById('comment-c2')!;
    expect(within(theirs).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(theirs).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(mine).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Delete' })).toBeTruthy();
    cleanup();
    renderThread(THREAD, { level: 'manage' });
    expect(within(document.getElementById('comment-t1')!).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('replies to the thread', async () => {
    renderThread(THREAD);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Thanks!' } });
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply' }), { key: 'Enter', metaKey: true }); });
    expect(postComment).toHaveBeenCalledWith('page-1', { body: { text: 'Thanks!', mentions: [] }, thread_id: 't1' });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
  });

  it('edits your own comment in place', async () => {
    renderThread(THREAD);
    fireEvent.click(within(document.getElementById('comment-c2')!).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(box.value).toBe('On it.');
    fireEvent.change(box, { target: { value: 'On it now.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(editComment).toHaveBeenCalledWith('c2', { text: 'On it now.', mentions: [] });
  });

  it('resolves and reopens for editors and the thread\'s author only', async () => {
    renderThread(THREAD);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resolve' })); });
    expect(resolveThread).toHaveBeenCalledWith('t1');
    cleanup();

    // a reader who didn't start the thread
    renderThread(THREAD, { level: 'view' });
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    cleanup();

    // the author, with only view — reopening a resolved thread
    const mine = { ...THREAD, resolved_at: new Date().toISOString(), resolved_by: ada,
      comments: [comment('t1'), comment('c2', { author: ada })] };
    renderThread(mine, { level: 'view' });
    expect(screen.getByText(/Resolved by Ada Lovelace/)).toBeTruthy();
    vi.mocked(reopenThread).mockRejectedValueOnce(new ApiError(403, 'forbidden', undefined, 'You need edit access.'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reopen' })); });
    expect(toast).toHaveBeenCalledWith('You need edit access.');
  });

  it('hides reply and edit from people who can\'t comment', () => {
    renderThread(THREAD, { level: 'view', canComment: false });
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('deletes after confirming, and reports a thread that went with it', async () => {
    const single = { ...THREAD, comments: [comment('t1')] };
    renderThread(single);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete this comment?')).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });
    expect(deleteComment).toHaveBeenCalledWith('t1');
    expect(onGone).toHaveBeenCalledWith('t1');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a thread that still has replies', async () => {
    const started = { ...THREAD, comments: [comment('t1'), comment('c2', { author: ada })] };
    renderThread(started);
    fireEvent.click(within(document.getElementById('comment-t1')!).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Its replies stay; the comment shows as deleted.')).toBeTruthy();
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })); });
    expect(onGone).not.toHaveBeenCalled();
  });

  it('highlights its text while hovered and asks to be picked when clicked', () => {
    renderThread(THREAD);
    const card = screen.getByRole('article');
    fireEvent.mouseEnter(card);
    expect(onHover).toHaveBeenLastCalledWith('t1');
    fireEvent.mouseLeave(card);
    expect(onHover).toHaveBeenLastCalledWith(null);
    fireEvent.click(card);
    expect(onFocus).toHaveBeenCalledWith('t1');
  });
});
