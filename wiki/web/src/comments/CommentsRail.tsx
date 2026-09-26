/** The Comments side of the page's right rail: "New comment" (a
 *  page-level thread), the composer for a comment on selected text, and
 *  the threads — open ones (inline threads in the order their text
 *  appears, then page-level ones by date), open inline threads whose text
 *  isn't in the displayed document, and the resolved ones, collapsed.
 *
 *  A comment on selected text: in edit mode (an editor, the live
 *  document) it becomes an inline thread — posted with `anchor`, then its
 *  `commentThread` mark goes on the selection, which was held in the
 *  shared Y.Doc meanwhile; if that text is gone by then, it's posted as a
 *  page-level thread quoting it. Anyone else (view mode) can't write the
 *  document, so it's a page-level thread whose text starts with the
 *  quoted selection.
 *
 *  Also here: `ReaderCommentBubble`, the "Comment" button over text
 *  selected in the read-only page. */
import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useState, type RefObject } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { Icon } from '../editor/icons';
import type { CommentBodyIn, CommentThread, Level } from '../lib/types';
import { errorMessage, postComment } from '../lib/wikiApi';
import CommentComposer, { MAX_COMMENT_CHARS } from './CommentComposer';
import { resolveCapture, type CapturedSelection } from './commentMarks';
import { arrangeThreads, quoteSelection, type ThreadAnchor } from './commentsStore';
import Thread from './Thread';

/** A comment being started: on the page, or on selected text (held
 *  in the live editor, or just quoted). */
export type NewComment =
  | { kind: 'page' }
  | { kind: 'inline'; captured: CapturedSelection }
  | { kind: 'quote'; text: string };

export interface CommentsRailProps {
  pageId: string;
  mode: 'view' | 'edit';
  level: Level | null;
  meId: string | null;
  canComment: boolean;
  threads: CommentThread[] | null;
  error: string | null;
  /** Where inline threads are in the displayed document (null: not read yet). */
  anchors: ReadonlyMap<string, ThreadAnchor> | null;
  /** The live editor, in edit mode — where inline comments are anchored. */
  editor: Editor | null;
  focusedThread: string | null;
  targetCommentId: string | null;
  onFocusThread: (threadId: string | null) => void;
  onHoverThread: (threadId: string | null) => void;
  newComment: NewComment | null;
  onNewComment: (next: NewComment | null) => void;
  refresh: () => Promise<void>;
  /** The thread was deleted outright. */
  onThreadGone: (threadId: string) => void;
}

const quoted = (text: string) => quoteSelection(text).slice(3, -3);

export default function CommentsRail({
  pageId, mode, level, meId, canComment, threads, error, anchors, editor, focusedThread, targetCommentId,
  onFocusThread, onHoverThread, newComment, onNewComment, refresh, onThreadGone,
}: CommentsRailProps) {
  const toast = useToast();
  const [showResolved, setShowResolved] = useState(false);
  const arranged = useMemo(() => arrangeThreads(threads ?? [], anchors), [threads, anchors]);

  // a thread picked elsewhere (its text, a link) opens the resolved list when it's there
  useEffect(() => {
    if (focusedThread && arranged.resolved.some((t) => t.thread_id === focusedThread)) setShowResolved(true);
  }, [focusedThread, arranged.resolved]);

  const post = async (body: CommentBodyIn, anchor = false) => {
    try {
      return await postComment(pageId, { body, ...(anchor ? { anchor: true } : {}) });
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t post your comment.'));
      throw err;
    }
  };
  const withQuote = (text: string, body: CommentBodyIn): CommentBodyIn => (
    { ...body, text: quoteSelection(text) + body.text });

  const start = async (body: CommentBodyIn) => {
    const pending = newComment ?? { kind: 'page' as const };
    let threadId: string;
    if (pending.kind === 'inline' && editor && !editor.isDestroyed) {
      const range = resolveCapture(editor, pending.captured);
      if (!range) {
        threadId = (await post(withQuote(pending.captured.text, body))).thread_id;
        toast('The text you selected was removed meanwhile, so your comment was added to the page, quoting it.');
      } else {
        threadId = (await post(body, true)).thread_id;
        const now = editor.isDestroyed ? null : resolveCapture(editor, pending.captured);
        if (!now || !editor.commands.setCommentThread(threadId, now)) {
          toast('Your comment was posted, but the text it was on was removed meanwhile.');
        }
      }
    } else if (pending.kind === 'inline' || pending.kind === 'quote') {
      const text = pending.kind === 'inline' ? pending.captured.text : pending.text;
      threadId = (await post(withQuote(text, body))).thread_id;
    } else {
      threadId = (await post(body)).thread_id;
    }
    onNewComment(null);
    onFocusThread(threadId);
    await refresh();
  };

  const threadProps = (t: CommentThread) => ({
    pageId,
    thread: t,
    anchorText: t.anchor ? anchors?.get(t.thread_id)?.text ?? null : null,
    level,
    meId,
    canComment,
    focused: focusedThread === t.thread_id,
    targetCommentId,
    onFocus: onFocusThread,
    onHover: onHoverThread,
    onChanged: refresh,
    onGone: onThreadGone,
  });

  const selection = newComment?.kind === 'inline' ? newComment.captured.text
    : newComment?.kind === 'quote' ? newComment.text : null;
  const quoteChars = selection !== null ? quoteSelection(selection).length : 0;
  const elsewhereLabel = mode === 'edit' ? 'On deleted text' : 'On text not in this version';

  return (
    <section className="wiki-comments" aria-label="Comments">
      {canComment && !newComment && (
        <button type="button" className="btn-ghost wiki-comments-new" onClick={() => onNewComment({ kind: 'page' })}>
          <Icon name="plus" />New comment
        </button>
      )}
      {newComment && (
        <div className="wiki-thread wiki-thread-new">
          {selection !== null && <blockquote className="wiki-thread-quote">{quoted(selection)}</blockquote>}
          <CommentComposer
            key={selection ?? 'page'}
            pageId={pageId}
            label={selection !== null ? 'Comment on the selected text' : 'New comment'}
            submitLabel="Comment"
            autoFocus
            maxLength={MAX_COMMENT_CHARS - quoteChars}
            onSubmit={start}
            onCancel={() => onNewComment(null)}
          />
        </div>
      )}

      {error && !threads && <p className="pf-error">{error}</p>}
      {!threads && !error && <p className="page-hint">Loading comments…</p>}
      {threads && !arranged.open.length && !arranged.elsewhere.length && !newComment && (
        <p className="page-hint wiki-comments-empty">
          {arranged.resolved.length ? 'No open comments.' : 'No comments yet.'}
          {canComment && ' Select text to comment on it, or start with New comment.'}
        </p>
      )}

      {arranged.open.map((t) => <Thread key={t.thread_id} {...threadProps(t)} />)}

      {arranged.elsewhere.length > 0 && (
        <div className="wiki-comments-group">
          <div className="wiki-comments-group-label">{elsewhereLabel} ({arranged.elsewhere.length})</div>
          {arranged.elsewhere.map((t) => <Thread key={t.thread_id} {...threadProps(t)} />)}
        </div>
      )}

      {arranged.resolved.length > 0 && (
        <div className="wiki-comments-group">
          <button type="button" className="wiki-comments-toggle" aria-expanded={showResolved}
                  onClick={() => setShowResolved((v) => !v)}>
            <Icon name={showResolved ? 'chevronDown' : 'chevronRight'} />
            Resolved ({arranged.resolved.length})
          </button>
          {showResolved && arranged.resolved.map((t) => <Thread key={t.thread_id} {...threadProps(t)} />)}
        </div>
      )}
    </section>
  );
}

// ── a reader's selection ────────────────────────────────────────────

/** A "Comment" button over text selected inside `container` (the
 *  read-only page); `onComment` gets the selected text. */
export function ReaderCommentBubble({ container, onComment }: {
  container: RefObject<HTMLElement>;
  onComment: (text: string) => void;
}) {
  const [spot, setSpot] = useState<{ top: number; left: number; text: string } | null>(null);

  useEffect(() => {
    const read = () => {
      const sel = window.getSelection();
      const root = container.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root) { setSpot(null); return; }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) { setSpot(null); return; }
      const text = sel.toString();
      if (!text.trim()) { setSpot(null); return; }
      const rect = range.getBoundingClientRect();
      const top = rect.top - 44;
      setSpot({
        top: top < 8 ? rect.bottom + 8 : top,
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - 52, window.innerWidth - 112)),
        text,
      });
    };
    // after the drag-select (or a keyboard selection) finishes
    const later = () => setTimeout(read, 0);
    document.addEventListener('mouseup', later);
    document.addEventListener('keyup', later);
    return () => {
      document.removeEventListener('mouseup', later);
      document.removeEventListener('keyup', later);
    };
  }, [container]);

  if (!spot) return null;
  return (
    <div className="we-bubble wiki-reader-bubble" role="toolbar" aria-label="Selected text"
         style={{ top: spot.top, left: spot.left }} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="we-tb-btn" onClick={() => {
                onComment(spot.text);
                window.getSelection()?.removeAllRanges();
                setSpot(null);
              }}>
        <Icon name="comment" />Comment
      </button>
    </div>
  );
}
