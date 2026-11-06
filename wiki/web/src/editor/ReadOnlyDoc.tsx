/** A stored page version, shown read-only: a non-editable Tiptap view of
 *  the shared schema with the wiki's node views and heading anchors —
 *  never raw HTML. With `publicAssets` it's the public share view: the
 *  node views look nothing up (see `PublicShare`). */
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';

import { PublicShare, withNodeViews, type PublicShareHooks } from './nodeViews';
import { wikiExtensions } from './schema';
import { HeadingIds, sectionHashTarget, sectionLinkTarget } from './toc';

/** How long a section opened from a link stays pinned while the images
 *  above it load and push it down (they don't reserve their height). */
const SETTLE_MS = 4000;

const scrollToHeading = (id: string, behavior: ScrollBehavior) =>
  document.getElementById(id)?.scrollIntoView?.({ behavior, block: 'start' });

export default function ReadOnlyDoc({ content, className, pageId, onEditor, publicAssets, publicHooks }: {
  content: JSONContent;
  className?: string;
  /** The page shown: its section links (`/n/<pageId>#h-…`) scroll in place
   *  instead of opening a new tab, and a `#h-…` hash opens at that section. */
  pageId?: string;
  /** The view's editor once it exists (null again when it goes) — e.g. to show comment marks. */
  onEditor?: (editor: Editor | null) => void;
  /** Public mode: every asset URL the content may show (asset id → URL). */
  publicAssets?: Record<string, string>;
  /** Public mode: keeping those URLs fresh (see PublicShareHooks). */
  publicHooks?: PublicShareHooks;
}) {
  // read through a ref: new hooks must not rebuild the editor
  const hooksRef = useRef(publicHooks);
  hooksRef.current = publicHooks;
  const extensions = useMemo(() => [
    ...withNodeViews(wikiExtensions()),
    HeadingIds,
    ...(publicAssets
      ? [PublicShare.configure({
        assetUrls: publicAssets,
        onAssetError: () => hooksRef.current?.onAssetError(),
        isStale: () => hooksRef.current?.isStale() ?? false,
        refresh: () => hooksRef.current?.refresh() ?? Promise.resolve(null),
      })]
      : []),
  ], [publicAssets]);
  const editor = useEditor({
    extensions,
    content,
    editable: false,
    editorProps: { attributes: { class: 'wiki-prose', 'aria-label': 'Page content', role: 'article' } },
  }, [extensions]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(content, false);
  }, [editor, content]);

  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    if (!editor) return undefined;
    onEditorRef.current?.(editor);
    return () => onEditorRef.current?.(null);
  }, [editor]);

  // `#h-…` in the address (a section link from another page): land on that
  // heading once the content is in, and keep it there while images load
  // above it — until the reader scrolls on their own.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    const id = pageId ? sectionHashTarget(window.location.hash) : null;
    if (!editor || !id || landed.current === id) return undefined;
    landed.current = id;
    const root = editor.view.dom;
    const settle = () => scrollToHeading(id, 'auto');
    const stop = () => {
      clearTimeout(timer);
      root.removeEventListener('load', settle, true);
      for (const type of ['wheel', 'touchmove', 'keydown']) window.removeEventListener(type, stop);
    };
    const timer = setTimeout(stop, SETTLE_MS);
    requestAnimationFrame(settle);
    root.addEventListener('load', settle, true);   // image loads don't bubble; capture sees them
    for (const type of ['wheel', 'touchmove', 'keydown']) window.addEventListener(type, stop, { passive: true });
    return stop;
  }, [editor, content, pageId]);

  // a link to a section of this page scrolls there instead of opening a tab
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!pageId || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href');
    const id = href ? sectionLinkTarget(href, pageId) : null;
    if (!id || !document.getElementById(id)) return;
    e.preventDefault();
    scrollToHeading(id, 'smooth');
    window.history.replaceState(window.history.state, '', `#${id}`);
  };

  return <EditorContent editor={editor} className={className ?? 'wiki-doc'} onClickCapture={onClickCapture} />;
}
