/** A stored page version, shown read-only: a non-editable Tiptap view of
 *  the shared schema with the wiki's node views and heading anchors —
 *  never raw HTML. With `publicAssets` it's the public share view: the
 *  node views look nothing up (see `PublicShare`). */
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef } from 'react';

import { PublicShare, withNodeViews } from './nodeViews';
import { wikiExtensions } from './schema';
import { HeadingIds } from './toc';

export default function ReadOnlyDoc({ content, className, onEditor, publicAssets }: {
  content: JSONContent;
  className?: string;
  /** The view's editor once it exists (null again when it goes) — e.g. to show comment marks. */
  onEditor?: (editor: Editor | null) => void;
  /** Public mode: every asset URL the content may show (asset id → URL). */
  publicAssets?: Record<string, string>;
}) {
  const extensions = useMemo(() => [
    ...withNodeViews(wikiExtensions()),
    HeadingIds,
    ...(publicAssets ? [PublicShare.configure({ assetUrls: publicAssets })] : []),
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

  return <EditorContent editor={editor} className={className ?? 'wiki-doc'} />;
}
