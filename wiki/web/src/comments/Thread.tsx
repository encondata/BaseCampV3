/** One comment thread in the rail: the text it's on (inline threads), its
 *  comments oldest first — plain text with @mention chips — and what the
 *  reader may do: reply, edit or delete their own comment (any, as a
 *  manager), resolve or reopen (editors and the thread's author). The
 *  API stays the judge; a refusal comes back as a toast. */
import { useEffect, useRef, useState } from 'react';

import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import ConfirmDialog from '../components/ConfirmDialog';
import { initials } from '../editor/MentionMenu';
import { Icon } from '../editor/icons';
import { personColor } from '../lib/personColor';
import type { CommentBodyIn, CommentOut, CommentThread, Level } from '../lib/types';
import {
  deleteComment, editComment, errorMessage, postComment, reopenThread, resolveThread,
} from '../lib/wikiApi';
import CommentComposer from './CommentComposer';
import { canDeleteComment, canResolveThread, mentionSegments } from './commentsStore';

export interface ThreadProps {
  pageId: string;
  thread: CommentThread;
  /** The text an inline thread is on, in the displayed document. */
  anchorText?: string | null;
  level: Level | null;
  meId: string | null;
  canComment: boolean;
  /** Picked (its text was clicked, or a link pointed here). */
  focused: boolean;
  /** A comment in this thread a link pointed at: scrolled to once, and
   *  highlighted while set. */
  targetCommentId?: string | null;
  onFocus: (threadId: string) => void;
  onHover: (threadId: string | null) => void;
  /** Something changed: load the threads again (resolves with them, or
   *  null when that failed). */
  onChanged: () => Promise<CommentThread[] | null>;
  /** After a delete, the reloaded threads no longer have this one. */
  onGone: (threadId: string) => void;
}

function CommentBody({ comment }: { comment: CommentOut }) {
  if (comment.deleted) return <p className="wiki-comment-body is-deleted">{comment.body.text}</p>;
  return (
    <p className="wiki-comment-body">
      {mentionSegments(comment.body.text, comment.body.mentions).map((seg, i) => ('person' in seg
        ? <span key={i} className="wiki-mention" title={seg.person.name}>@{seg.person.name}</span>
        : <span key={i}>{seg.text}</span>))}
    </p>
  );
}

export default function Thread({
  pageId, thread, anchorText, level, meId, canComment, focused, targetCommentId,
  onFocus, onHover, onChanged, onGone,
}: ThreadProps) {
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CommentOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const card = useRef<HTMLElement>(null);
  const resolved = !!thread.resolved_at;
  const mayResolve = canResolveThread(thread, level, meId);

  // picked: the card scrolls into view once each time — unless a linked
  // comment in it is what to show
  const wasFocused = useRef(false);
  const target = targetCommentId && thread.comments.some((c) => c.id === targetCommentId) ? targetCommentId : null;
  useEffect(() => {
    if (focused && !wasFocused.current && !target) {
      card.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
    wasFocused.current = focused;
  }, [focused, target]);
  // a linked comment scrolls into view once, not on every reload
  const shownTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!target || shownTarget.current === target) return;
    shownTarget.current = target;
    document.getElementById(`comment-${target}`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [target]);

  const failed = (err: unknown, fallback: string) => {
    toast(errorMessage(err, fallback));
    throw err;
  };

  const reply = async (body: CommentBodyIn) => {
    try {
      await postComment(pageId, { body, thread_id: thread.thread_id });
    } catch (err) {
      failed(err, 'Couldn\'t post your reply.');
    }
    setReplying(false);
    await onChanged();
  };

  const saveEdit = async (comment: CommentOut, body: CommentBodyIn) => {
    try {
      await editComment(comment.id, body);
    } catch (err) {
      failed(err, 'Couldn\'t save your comment.');
    }
    setEditing(null);
    await onChanged();
  };

  const setResolved = async (resolve: boolean) => {
    setBusy(true);
    try {
      await (resolve ? resolveThread(thread.thread_id) : reopenThread(thread.thread_id));
      await onChanged();
    } catch (err) {
      toast(errorMessage(err, resolve ? 'Couldn\'t resolve the thread.' : 'Couldn\'t reopen the thread.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(undefined);
    try {
      await deleteComment(deleting.id);
    } catch (err) {
      setBusy(false);
      setDeleteError(errorMessage(err, 'Couldn\'t delete the comment.'));
      return;
    }
    setBusy(false);
    setDeleting(null);
    // gone only if the server says so: a reply this page hasn't seen yet keeps it
    const fresh = await onChanged();
    if (fresh && !fresh.some((t) => t.thread_id === thread.thread_id)) onGone(thread.thread_id);
  };

  return (
    <article
      ref={card}
      id={`thread-${thread.thread_id}`}
      className={`wiki-thread${focused ? ' is-focused' : ''}${resolved ? ' is-resolved' : ''}`}
      aria-label={thread.anchor ? 'Comment thread on text' : 'Comment thread'}
      onMouseEnter={() => onHover(thread.thread_id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(thread.thread_id)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHover(null); }}
      onClick={(e) => {
        // its buttons, links and composer do their own thing
        if (e.target instanceof Element && e.target.closest('button, a, textarea, input, [role="option"]')) return;
        if (!focused) onFocus(thread.thread_id);
      }}
    >
      {anchorText && <blockquote className="wiki-thread-quote">{anchorText}</blockquote>}
      {thread.comments.map((c) => (
        <div key={c.id} id={`comment-${c.id}`}
             className={`wiki-comment${c.id === target ? ' is-target' : ''}`}>
          <div className="wiki-comment-head">
            <span className="wiki-comment-avatar" aria-hidden="true"
                  style={{ background: c.author ? personColor(c.author.id) : undefined }}>
              {c.author ? initials(c.author.name) : '?'}
            </span>
            <span className="wiki-comment-author">{c.author?.name ?? 'Someone'}</span>
            <span className="wiki-comment-time" title={new Date(c.created_at).toLocaleString()}>
              {relativeTime(c.created_at)}{c.edited_at && !c.deleted ? ' · edited' : ''}
            </span>
          </div>
          {editing === c.id ? (
            <CommentComposer pageId={pageId} label="Edit comment" submitLabel="Save" autoFocus
                             initialText={c.body.text} initialMentions={c.body.mentions}
                             onSubmit={(body) => saveEdit(c, body)} onCancel={() => setEditing(null)} />
          ) : (
            <CommentBody comment={c} />
          )}
          {editing !== c.id && !c.deleted && (
            <div className="wiki-comment-actions">
              {canComment && c.author?.id === meId && (
                <button type="button" className="wiki-link-btn" onClick={() => setEditing(c.id)}>Edit</button>
              )}
              {canDeleteComment(c, level, meId) && (
                <button type="button" className="wiki-link-btn" onClick={() => { setDeleteError(undefined); setDeleting(c); }}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {resolved && (
        <p className="wiki-thread-resolved">
          <Icon name="check" />
          Resolved{thread.resolved_by ? ` by ${thread.resolved_by.name}` : ''} · {relativeTime(thread.resolved_at)}
        </p>
      )}
      {replying ? (
        <CommentComposer pageId={pageId} label="Reply" submitLabel="Reply" autoFocus
                         placeholder={resolved ? 'Reply to reopen this thread…' : undefined}
                         onSubmit={reply} onCancel={() => setReplying(false)} />
      ) : (
        <div className="wiki-thread-actions">
          {canComment && (
            <button type="button" className="mini-btn" onClick={() => setReplying(true)}>Reply</button>
          )}
          {mayResolve && (
            <button type="button" className="mini-btn" disabled={busy}
                    onClick={() => void setResolved(!resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          eyebrow="Comments"
          title="Delete this comment?"
          description={deleting.id === thread.thread_id
            && thread.comments.some((c) => c.id !== deleting.id && !c.deleted)
            ? 'Its replies stay; the comment shows as deleted.'
            : 'This can\'t be undone.'}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          busy={busy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </article>
  );
}
