/** A page's comment threads for the comments rail: loading and polling
 *  them (`useCommentThreads`), arranging them for display
 *  (`arrangeThreads`), who may do what (mirroring the API, which stays
 *  the judge), and the plain-text helpers comment bodies need — the
 *  quoted selection a reader's comment starts with, and @mention chips.
 *  Bodies are plain text plus mention ids, never HTML. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { atLeast } from '../components/RowMenu';
import type { CommentOut, CommentThread, Level, PersonRef, SpaceOut } from '../lib/types';
import { errorMessage, listComments } from '../lib/wikiApi';

/** How often the open Comments tab asks for new comments. */
export const POLL_MS = 20_000;
/** The most of a selection a reader's comment quotes. */
export const QUOTE_CHARS = 200;

// ── rights (the API decides; these only shape the UI) ───────────────

/** Edit may always comment; view may while the space's
 *  `readers_can_comment` is on (the default) and it isn't archived. */
export function canCommentOn(level: Level | null, space: SpaceOut): boolean {
  if (atLeast(level, 'edit')) return true;
  return level === 'view' && !space.archived_at && space.settings.readers_can_comment !== false;
}

/** Editors, and whoever started the thread — taken from the first
 *  comment that still names its author (a deleted first comment may
 *  not; the API goes by the first comment's author regardless). */
export function canResolveThread(thread: CommentThread, level: Level | null, meId: string | null): boolean {
  if (atLeast(level, 'edit')) return true;
  const author = thread.comments.find((c) => c.author)?.author;
  return !!meId && author?.id === meId;
}

/** Your own comment, or any as a manager. */
export function canDeleteComment(comment: CommentOut, level: Level | null, meId: string | null): boolean {
  if (comment.deleted) return false;
  return (!!meId && comment.author?.id === meId) || atLeast(level, 'manage');
}

// ── arranging ───────────────────────────────────────────────────────

/** Where an inline thread's text is in the displayed document: the first
 *  marked position, and (a little of) the marked text. */
export interface ThreadAnchor {
  pos: number;
  text: string;
}

export interface ArrangedThreads {
  /** Open threads: inline ones in document order, then page-level ones by date. */
  open: CommentThread[];
  /** Open inline threads whose text isn't in the displayed document. */
  elsewhere: CommentThread[];
  /** Resolved threads, in the same order as `open`. */
  resolved: CommentThread[];
  /** Every open thread (`open` + `elsewhere`). */
  openCount: number;
}

const startedAt = (t: CommentThread) => t.comments[0]?.created_at ?? '';

function byPlace(anchors: ReadonlyMap<string, ThreadAnchor> | null) {
  return (a: CommentThread, b: CommentThread): number => {
    const pa = anchors?.get(a.thread_id)?.pos;
    const pb = anchors?.get(b.thread_id)?.pos;
    if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
    if (pa !== undefined && pb === undefined) return -1;
    if (pa === undefined && pb !== undefined) return 1;
    return startedAt(a).localeCompare(startedAt(b));
  };
}

/** `anchors` is null until the displayed document has been read: inline
 *  threads then keep their date order rather than all showing as
 *  "not in this version". */
export function arrangeThreads(
  threads: readonly CommentThread[], anchors: ReadonlyMap<string, ThreadAnchor> | null,
): ArrangedThreads {
  const open: CommentThread[] = [];
  const elsewhere: CommentThread[] = [];
  const resolved: CommentThread[] = [];
  for (const t of threads) {
    if (t.resolved_at) resolved.push(t);
    else if (t.anchor && anchors && !anchors.has(t.thread_id)) elsewhere.push(t);
    else open.push(t);
  }
  // before the document is read, every thread sorts by date
  const inlineFirst = byPlace(anchors);
  open.sort(anchors ? inlineFirst : (a, b) => startedAt(a).localeCompare(startedAt(b)));
  elsewhere.sort((a, b) => startedAt(a).localeCompare(startedAt(b)));
  resolved.sort(inlineFirst);
  return { open, elsewhere, resolved, openCount: open.length + elsewhere.length };
}

// ── text ────────────────────────────────────────────────────────────

/** The first line of a reader's comment on selected text: the selection
 *  on one line, cut to QUOTE_CHARS, as `> "…"` plus a blank line. */
export function quoteSelection(text: string): string {
  let flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length > QUOTE_CHARS) flat = `${flat.slice(0, QUOTE_CHARS - 1).trimEnd()}…`;
  return `> "${flat}"\n\n`;
}

export type BodySegment = { text: string } | { person: PersonRef };

/** A body's text with each `@Name` of a mentioned person as its own
 *  segment (longest names first, so "@Grace Hopper" beats "@Grace"). */
export function mentionSegments(text: string, mentions: readonly PersonRef[]): BodySegment[] {
  const people = [...mentions].filter((p) => p.name).sort((a, b) => b.name.length - a.name.length);
  const out: BodySegment[] = [];
  let rest = text;
  let plain = '';
  while (rest) {
    const hit = rest.startsWith('@') ? people.find((p) => rest.startsWith(`@${p.name}`)) : undefined;
    if (hit) {
      if (plain) out.push({ text: plain });
      plain = '';
      out.push({ person: hit });
      rest = rest.slice(hit.name.length + 1);
      continue;
    }
    const next = rest.indexOf('@', 1);
    const take = next === -1 ? rest.length : next;
    plain += rest.slice(0, take);
    rest = rest.slice(take);
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** The ids of the `picked` people whose `@Name` is still in `text`. */
export function mentionsIn(text: string, picked: readonly PersonRef[]): string[] {
  const ids = new Set<string>();
  for (const p of picked) if (text.includes(`@${p.name}`)) ids.add(p.id);
  return [...ids];
}

/** The comment a `#comment-<id>` location hash points at. */
export function commentLinkTarget(hash: string): string | null {
  const m = /^#comment-(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// ── loading ─────────────────────────────────────────────────────────

export interface CommentThreadsState {
  /** null until the first answer. */
  threads: CommentThread[] | null;
  error: string | null;
  /** Reloads now. Resolves with what this request found (null when it
   *  failed), even when a newer request's answer is the one shown. */
  refresh: () => Promise<CommentThread[] | null>;
}

/** The page's threads, once `enabled` (default on): loaded then, and
 *  every POLL_MS while `poll` and the tab is visible (and at once when it
 *  becomes visible again). Only the newest request's answer is shown. */
export function useCommentThreads(
  pageId: string, { enabled = true, poll }: { enabled?: boolean; poll: boolean },
): CommentThreadsState {
  const [state, setState] = useState<{ pageId: string; threads: CommentThread[] | null; error: string | null }>(
    { pageId, threads: null, error: null });
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<CommentThread[] | null> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const threads = await listComments(pageId);
      if (mine === seq.current) setState({ pageId, threads, error: null });
      return threads;
    } catch (err) {
      if (mine === seq.current) {
        setState((s) => ({
          pageId,
          threads: s.pageId === pageId ? s.threads : null,
          error: errorMessage(err, 'Couldn\'t load the comments.'),
        }));
      }
      return null;
    }
  }, [pageId]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    // a later page's answers only
    return () => { seq.current += 1; };
  }, [refresh, enabled]);

  useEffect(() => {
    if (!poll || !enabled) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [poll, enabled, refresh]);

  const shown = state.pageId === pageId ? state : { threads: null, error: null };
  return { threads: shown.threads, error: shown.error, refresh };
}
