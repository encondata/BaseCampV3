/** A page: breadcrumbs, title (renamed in place by editors), the meta line
 *  (who published it and when; "Unpublished changes" for editors), the
 *  actions (View ↔ Edit, Publish, History, Favorite, ⋯) and, beside the
 *  content, a rail that switches between a table of contents built from
 *  its headings and the page's comments (`#comment-<id>` opens the
 *  comments at that comment). Commented text is highlighted in the page
 *  shown (the published version, or the live draft while editing):
 *  clicking it picks its thread, and hovering a thread lights its text.
 *
 *  View mode shows the published version read-only (ReadOnlyDoc). Edit
 *  mode (`?edit=1`, editors only — and where editors land on a page that
 *  was never published) mounts the live editor.
 *
 *  `?restore=<versionId>` (from History's Restore, edit mode only) loads
 *  that version and, once the editor holds the live document, puts it in
 *  (which syncs to everyone), stores it, records the `restored` version and
 *  drops the param.
 *
 *  Publishing snapshots the STORED draft, which trails the live document
 *  by up to 10 s, so Publish first stores the live document (`flushDraft`):
 *  through the open editor in Edit mode, or a short-lived connection from
 *  View mode (someone else may be editing). */
import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { ApiError } from '@portal/lib/api';
import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';
import { useSystemStatus } from '@portal/lib/systemStatusContext';

import { captureSelection, revealAnchor, useCommentMarks } from '../comments/commentMarks';
import CommentsRail, { ReaderCommentBubble, type NewComment } from '../comments/CommentsRail';
import { canCommentOn, commentLinkTarget, useCommentThreads } from '../comments/commentsStore';
import ConfirmDialog from '../components/ConfirmDialog';
import RowMenu, { atLeast } from '../components/RowMenu';
import SaveAsTemplateDialog from '../components/SaveAsTemplateDialog';
import WatchButton from '../components/WatchButton';
import { Icon } from '../editor/icons';
import { flushPage } from '../editor/flushPage';
import PublishDialog from '../editor/PublishDialog';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { buildToc, type TocEntry } from '../editor/toc';
import WikiEditor, { type EditorUser } from '../editor/WikiEditor';
import { PERSON_COLORS, personColor } from '../lib/personColor';
import { noteChanged } from '../lib/treeStore';
import type { NodeDetailOut, PageContentOut, VersionDetail, VersionOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { errorMessage, getPageContent, getVersion, recordRestore, setFavorite } from '../lib/wikiApi';
import { Breadcrumbs, InlineTitle } from './FolderView';

/** How long a comment a link pointed at stands out. */
export const TARGET_HIGHLIGHT_MS = 4000;

type Published =
  | { status: 'loading' }
  | { status: 'ready'; content: PageContentOut }
  | { status: 'unpublished' }
  | { status: 'error'; message: string };

/** The published version, refetched when the page publishes again. */
function usePublished(pageId: string, versionId: string | null, reload: number): Published {
  const [state, setState] = useState<{ key: string; value: Published } | null>(null);
  const key = `${pageId}:${versionId ?? ''}:${reload}`;
  useEffect(() => {
    let live = true;
    getPageContent(pageId, 'published')
      .then((content) => { if (live) setState({ key, value: { status: 'ready', content } }); })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404 && err.code === 'not_published') {
          setState({ key, value: { status: 'unpublished' } });
        } else {
          setState({ key, value: { status: 'error', message: errorMessage(err, 'Couldn\'t load this page.') } });
        }
      });
    return () => { live = false; };
  }, [pageId, key]);
  return state?.key === key ? state.value : { status: 'loading' };
}

/** The signed-in person as a collaborator: name and presence color. */
function useEditorUser(): EditorUser {
  const me = useWikiMe();
  const { person } = useAuth();
  const id = me?.person.id ?? person?.id ?? null;
  const name = me?.person.name ?? person?.display_name ?? 'Someone';
  return useMemo(() => ({ name, color: id ? personColor(id) : PERSON_COLORS[0] }), [id, name]);
}

/** The signed-in person's id. */
function useMeId(): string | null {
  const me = useWikiMe();
  const { person } = useAuth();
  return me?.person.id ?? person?.id ?? null;
}

function TableOfContents({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState<string | null>(null);

  // highlight the section being read
  useEffect(() => {
    if (!entries.length) return undefined;
    const scroller: HTMLElement | Window = document.querySelector<HTMLElement>('.wiki-main') ?? window;
    const onScroll = () => {
      let current: string | null = null;
      for (const e of entries) {
        const el = document.getElementById(e.id);
        if (el && el.getBoundingClientRect().top <= 140) current = e.id;
      }
      setActive(current ?? entries[0].id);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [entries]);

  if (!entries.length) return <p className="page-hint wiki-rail-empty">No headings on this page yet.</p>;
  const base = Math.min(...entries.map((e) => e.level));
  return (
    <nav className="wiki-toc" aria-label="On this page">
      <div className="wiki-toc-label">On this page</div>
      <ul>
        {entries.map((e) => (
          <li key={e.id} style={{ ['--toc-depth' as string]: Math.min(e.level - base, 3) }}>
            <a href={`#${e.id}`} className={active === e.id ? 'on' : undefined}
               onClick={(ev) => {
                 ev.preventDefault();
                 document.getElementById(e.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                 setActive(e.id);
               }}>
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NotPublished({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="wiki-empty-page">
      <Icon name="file" className="wiki-empty-icon" />
      <b>This page hasn't been published yet</b>
      <span>{canEdit ? 'Switch to Edit to write it, then publish it for readers.'
        : 'It will show up here once an editor publishes it.'}</span>
    </div>
  );
}

export default function PageView({ node }: { node: NodeDetailOut }) {
  const toast = useToast();
  const user = useEditorUser();
  const [params, setParams] = useSearchParams();
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [editBlocked, setEditBlocked] = useState(false);
  const [liveToc, setLiveToc] = useState<TocEntry[]>([]);
  const [favorite, setFavoriteState] = useState(node.is_favorite);

  useEffect(() => { setEditBlocked(false); setLiveToc([]); }, [node.id]);
  useEffect(() => { setFavoriteState(node.is_favorite); }, [node.id, node.is_favorite]);

  const page = node.page;
  const canEdit = atLeast(node.my_level, 'edit') && !editBlocked;
  const published = usePublished(node.id, page?.published_version_id ?? null, reload);
  const editParam = params.get('edit');
  const neverPublished = !page?.published_version_id;
  const mode: 'view' | 'edit' = canEdit && (editParam === '1' || (neverPublished && editParam !== '0'))
    ? 'edit' : 'view';

  // ── restoring a version (History → Restore) ──
  const restoreId = mode === 'edit' ? params.get('restore') : null;
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  // the open editor's own flush, while there is one
  const liveFlush = useRef<(() => Promise<void>) | null>(null);
  const onLiveFlush = useCallback((flush: (() => Promise<void>) | null) => { liveFlush.current = flush; }, []);
  const flushDraft = useCallback(
    () => (liveFlush.current ? liveFlush.current() : flushPage(node.id)),
    [node.id],
  );
  const [restoreSource, setRestoreSource] = useState<VersionDetail | null>(null);
  const restoredRef = useRef<string | null>(null);
  useEffect(() => { setLiveEditor(null); }, [node.id, mode]);
  useEffect(() => { if (!restoreId) restoredRef.current = null; }, [restoreId]);

  const clearRestore = useCallback(() => {
    setParams((cur) => {
      const p = new URLSearchParams(cur);
      p.delete('restore');
      return p;
    }, { replace: true });
  }, [setParams]);

  // `?restore=` only means something in edit mode. If it lingers while
  // editing isn't possible — a plain viewer, or editing blocked (e.g. by
  // access loss) before the restore ever got to apply — tell the reader
  // once and drop it, rather than leaving a dead param in the URL.
  useEffect(() => {
    if (mode === 'edit' || !params.get('restore')) return;
    toast('Couldn\'t restore — you can\'t edit this page right now.');
    clearRestore();
  }, [mode, params, toast, clearRestore]);

  useEffect(() => {
    if (!restoreId) return undefined;
    let live = true;
    getVersion(node.id, restoreId)
      .then((v) => { if (live) setRestoreSource(v); })
      .catch((err) => {
        if (!live) return;
        toast(errorMessage(err, 'Couldn\'t load that version to restore it.'));
        clearRestore();
      });
    return () => { live = false; };
  }, [node.id, restoreId, toast, clearRestore]);

  useEffect(() => {
    if (!restoreId || !liveEditor || restoreSource?.id !== restoreId || restoredRef.current === restoreId) return;
    if (liveEditor.isDestroyed) return;
    restoredRef.current = restoreId;
    const { version_no: versionNo, content_json: content } = restoreSource;
    liveEditor.commands.setContent(content, true);
    // stored first, so the draft (and a Publish right after) has it
    flushDraft().catch(() => undefined)
      .then(() => recordRestore(node.id, restoreId))
      .then(() => toast(`Restored version ${versionNo}. Publish when it's ready for readers.`))
      .catch((err) => toast(errorMessage(err,
        `Version ${versionNo} is back in the editor, but couldn't be recorded in the history.`)))
      .finally(clearRestore);
  }, [node.id, restoreId, liveEditor, restoreSource, toast, clearRestore, flushDraft]);

  const setMode = (next: 'view' | 'edit') => {
    setParams((cur) => {
      const p = new URLSearchParams(cur);
      p.set('edit', next === 'edit' ? '1' : '0');
      if (next === 'view' && !neverPublished) p.delete('edit');
      return p;
    }, { replace: true });
  };

  // The server doesn't say why a connection went read-only or was refused;
  // the system status tells read-only mode apart from everything else.
  const { status: systemStatus, refresh: refreshSystemStatus } = useSystemStatus();
  const readOnlyMode = useRef(systemStatus.read_only);
  readOnlyMode.current = systemStatus.read_only;
  const onAccessLost = useCallback((level: 'view' | 'none') => {
    setEditBlocked(true);
    if (readOnlyMode.current) {
      toast('The wiki is in read-only mode right now — showing the published version.');
    } else if (level === 'view') {
      toast('You can\'t edit this page right now — showing the published version.');
    } else {
      toast('Live editing stopped — the page may have moved or your access changed. Refresh to try again.');
    }
    refreshSystemStatus();
    noteChanged(node);
  }, [node, toast, refreshSystemStatus]);

  const onPublished = (version: VersionOut) => {
    setReload((n) => n + 1);
    noteChanged({
      ...node,
      page: page && {
        ...page, published_version_id: version.id, published_at: version.created_at, has_unpublished_changes: false,
      },
    });
  };

  const toggleFavorite = async () => {
    const next = !favorite;
    setFavoriteState(next);
    try {
      await setFavorite(node.id, next);
      noteChanged({ ...node, is_favorite: next });
    } catch (err) {
      setFavoriteState(!next);
      toast(errorMessage(err, next ? 'Couldn\'t add it to your favorites.' : 'Couldn\'t remove it from your favorites.'));
    }
  };

  // ── comments ──
  const meId = useMeId();
  const location = useLocation();
  const linkedComment = commentLinkTarget(location.hash);
  const canComment = canCommentOn(node.my_level, node.space);
  const [tab, setTab] = useState<'contents' | 'comments'>(linkedComment ? 'comments' : 'contents');
  const showRail = mode === 'edit' || published.status === 'ready';
  const comments = useCommentThreads(node.id, { enabled: showRail, poll: tab === 'comments' });
  const [viewEditor, setViewEditor] = useState<Editor | null>(null);
  const shownEditor = mode === 'edit' ? liveEditor : viewEditor;
  const [focusedThread, setFocusedThread] = useState<string | null>(null);
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const [newComment, setNewComment] = useState<NewComment | null>(null);
  // whether the new comment's composer holds unsent text, and a selection
  // waiting on "replace the one it's on?"
  const hasDraft = useRef(false);
  const [replacing, setReplacing] = useState<NewComment | null>(null);
  // the comment a link pointed at, highlighted for a moment
  const [target, setTarget] = useState<{ commentId: string; threadId: string } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);

  // a held selection belongs to the document it was made in
  useEffect(() => { setNewComment(null); setFocusedThread(null); setReplacing(null); }, [node.id, mode]);
  useEffect(() => { if (!newComment) hasDraft.current = false; }, [newComment]);
  useEffect(() => { if (linkedComment) setTab('comments'); }, [linkedComment]);

  // `#comment-<id>`: pick that comment's thread once the threads are in —
  // once per link, not on every reload
  const linkedHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedComment || !comments.threads || linkedHandled.current === linkedComment) return;
    linkedHandled.current = linkedComment;
    const found = comments.threads.find((t) => t.comments.some((c) => c.id === linkedComment));
    if (found) {
      setFocusedThread(found.thread_id);
      setTarget({ commentId: linkedComment, threadId: found.thread_id });
    } else {
      toast('That comment isn\'t here any more — it may have been deleted.');
    }
  }, [linkedComment, comments.threads, toast]);
  useEffect(() => {
    if (!target) return undefined;
    const timer = setTimeout(() => setTarget(null), TARGET_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [target]);
  /** Pick a thread; the linked comment stops standing out once another is picked. */
  const pickThread = useCallback((threadId: string | null) => {
    setFocusedThread(threadId);
    setTarget((cur) => (cur && cur.threadId === threadId ? cur : null));
  }, []);

  const threadsRef = useRef(comments.threads);
  threadsRef.current = comments.threads;
  const onMarkClick = useCallback((ids: string[]) => {
    const threads = threadsRef.current ?? [];
    const known = (id: string, open: boolean) => threads.some((t) => t.thread_id === id && (!open || !t.resolved_at));
    const picked = ids.find((id) => known(id, true)) ?? ids.find((id) => known(id, false));
    if (!picked) return;
    setTab('comments');
    pickThread(picked);
  }, [pickThread]);
  const anchors = useCommentMarks(shownEditor, {
    active: hoveredThread ?? focusedThread, threads: comments.threads, onMarkClick,
  });

  // picked in the rail: bring its text into view too
  const focusThread = (threadId: string | null) => {
    pickThread(threadId);
    const anchor = threadId ? anchors?.get(threadId) : undefined;
    if (shownEditor && anchor) revealAnchor(shownEditor, anchor.pos);
  };
  // a new selection takes over an empty composer; over unsent text, ask first
  const startOn = useCallback((next: NewComment) => {
    setTab('comments');
    if (hasDraft.current) setReplacing(next);
    else setNewComment(next);
  }, []);
  const commentOnSelection = useCallback((editor: Editor) => {
    const captured = captureSelection(editor);
    if (captured) startOn({ kind: 'inline', captured });
  }, [startOn]);
  const commentOnQuote = useCallback((text: string) => startOn({ kind: 'quote', text }), [startOn]);
  const onDraftChange = useCallback((draft: boolean) => { hasDraft.current = draft; }, []);
  // a deleted thread's text isn't commented any more (resolved threads keep theirs)
  const onThreadGone = (threadId: string) => {
    if (mode === 'edit' && liveEditor && !liveEditor.isDestroyed) liveEditor.commands.unsetCommentThread(threadId);
    if (focusedThread === threadId) pickThread(null);
  };
  const openThreads = comments.threads?.filter((t) => !t.resolved_at).length;

  const viewToc = useMemo(
    () => (published.status === 'ready' ? buildToc(published.content.content_json) : []),
    [published],
  );
  const toc = mode === 'edit' ? liveToc : viewToc;

  let meta = '';
  if (published.status === 'ready') {
    const by = published.content.created_by?.name;
    const when = published.content.created_at ? relativeTime(published.content.created_at) : '';
    meta = [by ? `Published by ${by}` : 'Published', when].filter(Boolean).join(' · ');
  } else if (published.status === 'unpublished') {
    meta = 'Not published yet';
  }

  return (
    <div className="portal-page wiki-page wiki-page-view" data-testid="page-view" data-mode={mode}>
      <Breadcrumbs node={node} />
      <header className="wiki-page-head">
        <div className="wiki-page-head-main">
          <InlineTitle node={node} label="Page title" showIcon={false} />
          <div className="wiki-page-meta">
            {meta && (
              <span title={published.status === 'ready' && published.content.created_at
                ? new Date(published.content.created_at).toLocaleString() : undefined}>{meta}</span>
            )}
            {canEdit && page?.has_unpublished_changes && !neverPublished && (
              <span className="chip c-amber"><span className="dot" />Unpublished changes</span>
            )}
          </div>
        </div>
        <div className="wiki-page-actions">
          {canEdit && (
            <div className="segmented wiki-mode" role="group" aria-label="Mode">
              <button type="button" className={mode === 'view' ? 'on' : undefined} aria-pressed={mode === 'view'}
                      onClick={() => setMode('view')}>View</button>
              <button type="button" className={mode === 'edit' ? 'on' : undefined} aria-pressed={mode === 'edit'}
                      onClick={() => setMode('edit')}>Edit</button>
            </div>
          )}
          {canEdit && (
            <button type="button" className="btn-solid wiki-publish-btn" onClick={() => setPublishing(true)}>
              Publish
            </button>
          )}
          <Link className="btn-ghost wiki-history-btn" to={`/n/${node.id}/history`}>
            <Icon name="history" />History
          </Link>
          <WatchButton target={{ kind: 'node', nodeId: node.id }} />
          <button type="button" className={`wiki-icon-btn wiki-fav-btn${favorite ? ' on' : ''}`}
                  aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
                  title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={favorite} onClick={() => void toggleFavorite()}>
            <Icon name="star" />
          </button>
          <RowMenu node={node} onSaveAsTemplate={() => setSavingTemplate(true)} />
        </div>
      </header>

      <div className={`wiki-page-body${showRail ? ' has-rail' : ''}`}>
        <div className="wiki-page-content" ref={docRef}>
          {mode === 'edit' ? (
            <WikiEditor pageId={node.id} user={user} onAccessLost={onAccessLost} onToc={setLiveToc}
                        onFirstSync={setLiveEditor} onLiveFlush={onLiveFlush}
                        onComment={canComment ? commentOnSelection : undefined} />
          ) : (
            <>
              {published.status === 'loading' && <p className="page-hint">Loading…</p>}
              {published.status === 'error' && <p className="pf-error">{published.message}</p>}
              {published.status === 'unpublished' && <NotPublished canEdit={canEdit} />}
              {published.status === 'ready' && (
                <ReadOnlyDoc content={published.content.content_json} onEditor={setViewEditor} />
              )}
              {published.status === 'ready' && canComment && (
                <ReaderCommentBubble container={docRef} onComment={commentOnQuote} />
              )}
            </>
          )}
        </div>
        {showRail && (
          <aside className="wiki-page-rail">
            <div className="segmented wiki-rail-tabs" role="group" aria-label="Side panel">
              <button type="button" className={tab === 'contents' ? 'on' : undefined} aria-pressed={tab === 'contents'}
                      onClick={() => setTab('contents')}>Contents</button>
              <button type="button" className={tab === 'comments' ? 'on' : undefined} aria-pressed={tab === 'comments'}
                      onClick={() => setTab('comments')}>
                {openThreads === undefined ? 'Comments' : `Comments (${openThreads})`}
              </button>
            </div>
            {tab === 'contents' ? <TableOfContents entries={toc} /> : (
              <CommentsRail
                pageId={node.id} mode={mode} level={node.my_level} meId={meId} canComment={canComment}
                threads={comments.threads} error={comments.error} anchors={anchors}
                editor={mode === 'edit' ? liveEditor : null}
                focusedThread={focusedThread} targetCommentId={target?.commentId ?? null}
                onFocusThread={focusThread} onHoverThread={setHoveredThread}
                newComment={newComment} onNewComment={setNewComment} onDraftChange={onDraftChange}
                refresh={comments.refresh} onThreadGone={onThreadGone}
              />
            )}
          </aside>
        )}
      </div>

      {replacing && (
        <ConfirmDialog
          eyebrow="Comments"
          title="Replace the selection for this comment?"
          description="What you've written stays; the comment would be on the text you just selected instead."
          confirmLabel="Replace"
          cancelLabel="Keep the current one"
          onConfirm={() => { setNewComment(replacing); setReplacing(null); }}
          onCancel={() => setReplacing(null)}
        />
      )}
      {publishing && (
        <PublishDialog pageId={node.id} pageTitle={node.title} flush={flushDraft}
                       onClose={() => setPublishing(false)} onPublished={onPublished} />
      )}
      {savingTemplate && (
        <SaveAsTemplateDialog node={node} onClose={() => setSavingTemplate(false)} />
      )}
    </div>
  );
}
