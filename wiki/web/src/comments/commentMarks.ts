/** The comments rail's side of the page's text: where each inline
 *  thread's `commentThread` mark is (`threadAnchors`, for ordering the
 *  rail), how marks look (a decoration, never a document change — the
 *  thread in focus stands out, a resolved thread's text is muted, and a
 *  mark whose thread is gone shows nothing), clicks on marked text, and
 *  holding on to a selection while its comment is written.
 *
 *  Works on any editor showing the page: the live one (edit mode) or the
 *  read-only one (view mode). */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useEffect, useRef, useState } from 'react';
import type { RelativePosition } from 'yjs';

import { fromRelative, toRelative } from '../editor/uploads';
import type { CommentThread } from '../lib/types';
import type { ThreadAnchor } from './commentsStore';

const MARK = 'commentThread';
const ANCHOR_TEXT_CHARS = 120;
const REREAD_MS = 250;

function threadIdsOf(node: PMNode): string[] {
  const ids: string[] = [];
  for (const m of node.marks) {
    const id = m.type.name === MARK ? m.attrs.threadId : null;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Each thread anchored in `doc`, in document order: its first position
 *  and its marked text (joined, trimmed to a short excerpt). */
export function threadAnchors(doc: PMNode): Map<string, ThreadAnchor> {
  const found = new Map<string, { pos: number; parts: string[] }>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const id of threadIdsOf(node)) {
      let entry = found.get(id);
      if (!entry) {
        entry = { pos, parts: [] };
        found.set(id, entry);
      }
      if (node.isText) entry.parts.push(node.text ?? '');
    }
    return false;
  });
  const out = new Map<string, ThreadAnchor>();
  for (const [id, { pos, parts }] of found) {
    let text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > ANCHOR_TEXT_CHARS) text = `${text.slice(0, ANCHOR_TEXT_CHARS - 1).trimEnd()}…`;
    out.set(id, { pos, text });
  }
  return out;
}

// ── the highlight plugin ────────────────────────────────────────────

interface Look {
  /** The thread in focus (hovered or selected in the rail). */
  active: string | null;
  /** Open threads; null until the threads have loaded (everything plain). */
  open: ReadonlySet<string> | null;
  resolved: ReadonlySet<string>;
}

interface MarksState extends Look {
  deco: DecorationSet;
}

function classFor(ids: string[], look: Look): string {
  if (!look.open) return '';
  if (look.active && ids.includes(look.active)) return 'is-active';
  if (ids.some((id) => look.open!.has(id))) return '';
  if (ids.some((id) => look.resolved.has(id))) return 'is-resolved';
  return 'is-stale';
}

function decorate(doc: PMNode, look: Look): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const ids = threadIdsOf(node);
    if (ids.length) {
      const extra = classFor(ids, look);
      decos.push(Decoration.inline(pos, pos + node.nodeSize, {
        class: extra ? `wiki-comment-anchor ${extra}` : 'wiki-comment-anchor',
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

function sliceHasMark(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (node.marks.some((m) => m.type.name === MARK)) found = true;
    return !found;
  });
  return found;
}

/** Whether `tr` may have added or removed comment marks: a mark step for
 *  one, or content put in that carries one (a paste, typing inside
 *  marked text, a remote change). Anything else — typing elsewhere,
 *  deleting text — only moves the highlights, so they're mapped. */
function touchesCommentMarks(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return step.mark.type.name === MARK;
    const { slice } = step as { slice?: Slice };
    return !!slice && sliceHasMark(slice);
  });
}

let pluginSeq = 0;

function marksPlugin(key: PluginKey<MarksState>, onClick: (ids: string[]) => void): Plugin<MarksState> {
  return new Plugin<MarksState>({
    key,
    state: {
      init: (_config, state) => {
        const look: Look = { active: null, open: null, resolved: new Set() };
        return { ...look, deco: decorate(state.doc, look) };
      },
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(key) as Look | undefined;
        if (meta) return { ...meta, deco: decorate(state.doc, meta) };
        if (!tr.docChanged) return value;
        if (touchesCommentMarks(tr)) return { ...value, deco: decorate(state.doc, value) };
        return { ...value, deco: value.deco.map(tr.mapping, tr.doc) };
        return value;
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.deco ?? DecorationSet.empty,
      attributes: { class: 'wiki-comment-marks' },
      handleDOMEvents: {
        click: (view, event) => {
          const ids: string[] = [];
          let el = event.target instanceof Element ? event.target : null;
          while (el && el !== view.dom) {
            const id = el.getAttribute('data-comment-thread');
            if (id && !ids.includes(id)) ids.push(id);
            el = el.parentElement;
          }
          if (ids.length) onClick(ids);
          return false;
        },
      },
    },
  });
}

export interface CommentMarksOptions {
  active: string | null;
  /** The page's threads; null while loading. */
  threads: readonly CommentThread[] | null;
  /** Marked text was clicked: its threads, innermost mark first. */
  onMarkClick: (threadIds: string[]) => void;
}

/** Shows the comment marks in `editor` for the rail and reads where they
 *  are. Returns each anchored thread's place in the document (re-read as
 *  it changes), or null without an editor. */
export function useCommentMarks(
  editor: Editor | null, { active, threads, onMarkClick }: CommentMarksOptions,
): Map<string, ThreadAnchor> | null {
  const clickRef = useRef(onMarkClick);
  clickRef.current = onMarkClick;
  const keyRef = useRef<PluginKey<MarksState> | null>(null);
  const [anchors, setAnchors] = useState<{ editor: Editor; anchors: Map<string, ThreadAnchor> } | null>(null);

  // the plugin, for as long as this editor is shown
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    pluginSeq += 1;
    const key = new PluginKey<MarksState>(`wikiCommentMarks${pluginSeq}`);
    keyRef.current = key;
    editor.registerPlugin(marksPlugin(key, (ids) => clickRef.current(ids)));
    return () => {
      keyRef.current = null;
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor]);

  // how the marks look
  useEffect(() => {
    const key = keyRef.current;
    if (!editor || editor.isDestroyed || !key) return;
    const look: Look = {
      active,
      open: threads ? new Set(threads.filter((t) => !t.resolved_at).map((t) => t.thread_id)) : null,
      resolved: new Set((threads ?? []).filter((t) => t.resolved_at).map((t) => t.thread_id)),
    };
    editor.view.dispatch(editor.state.tr.setMeta(key, look));
  }, [editor, active, threads]);

  // where the marks are: now, and shortly after each change
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    const read = () => { if (!editor.isDestroyed) setAnchors({ editor, anchors: threadAnchors(editor.state.doc) }); };
    read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(read, REREAD_MS);
    };
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); clearTimeout(timer); };
  }, [editor]);

  return editor && anchors?.editor === editor ? anchors.anchors : null;
}

// ── a selection to comment on ───────────────────────────────────────

/** A selection held while its comment is written: its positions, the
 *  same spots in the shared Y.Doc (so other people's edits meanwhile
 *  don't move it; null when not collaborating), and its text. */
export interface CapturedSelection {
  from: number;
  to: number;
  fromRel: RelativePosition | null;
  toRel: RelativePosition | null;
  text: string;
}

/** The editor's selected text, or null when nothing (or only space) is selected. */
export function captureSelection(editor: Editor): CapturedSelection | null {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const text = state.doc.textBetween(from, to, '\n', ' ');
  if (!text.trim()) return null;
  return { from, to, fromRel: toRelative(state, from), toRel: toRelative(state, to), text };
}

/** Where a captured selection is now, or null when its text is gone. A
 *  selection held without the Y.Doc can't follow edits: it only stands
 *  while its text is unchanged. */
export function resolveCapture(editor: Editor, captured: CapturedSelection): { from: number; to: number } | null {
  const { state } = editor;
  const tracked = !!captured.fromRel && !!captured.toRel;
  const from = tracked ? fromRelative(state, captured.fromRel) : captured.from;
  const to = tracked ? fromRelative(state, captured.toRel) : captured.to;
  if (from === null || to === null || from >= to || to > state.doc.content.size) return null;
  const text = state.doc.textBetween(from, to, '\n', ' ');
  if (!text.trim()) return null;
  if (!tracked && text !== captured.text) return null;
  return { from, to };
}

/** Scrolls the text at `pos` into view. */
export function revealAnchor(editor: Editor, pos: number): void {
  if (editor.isDestroyed) return;
  try {
    const { node } = editor.view.domAtPos(pos + 1);
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  } catch {
    /* not laid out */
  }
}
