/** A template's content, edited standalone — the same toolbar and
 *  extensions as the live page editor, minus Collaboration and
 *  CollaborationCursor: a template has no Y.Doc of its own, no presence to
 *  show, and (unlike a page) nothing else can be editing it at once. Image
 *  and file uploads aren't offered either — a template isn't a node, so it
 *  has nowhere to store an asset (the server strips any that sneak in via
 *  `strip_asset_nodes`); linking to another page still works. */
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import LinkPopover from './LinkPopover';
import { insertPageLink, PageLinkMenu, PickerPopover, type PickedNode } from './PagePicker';
import { withNodeViews } from './nodeViews';
import { wikiExtensions } from './schema';
import SlashMenu from './SlashMenu';
import { menuPosition } from './suggest';
import { HeadingIds } from './toc';
import Toolbar, { type ToolbarActions } from './Toolbar';

const PLACEHOLDER = 'Type “/” for blocks, “[[” to link a page…';

type Anchor = { top: number; left: number };

export default function TemplateEditor({ content, onChange, onEditor }: {
  content: JSONContent;
  /** The document, whenever it changes. */
  onChange?: (json: JSONContent) => void;
  /** The editor once it exists (null again when it goes). */
  onEditor?: (editor: Editor | null) => void;
}) {
  const toast = useToast();
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [linkAt, setLinkAt] = useState<Anchor | null>(null);
  const extensions = useMemo(() => [...withNodeViews(wikiExtensions({ placeholder: PLACEHOLDER })), HeadingIds], []);

  const editor = useEditor({
    extensions,
    content,
    editorProps: { attributes: { class: 'wiki-prose', 'aria-label': 'Template content', spellcheck: 'true' } },
  }, [extensions]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!editor) return undefined;
    const emit = () => onChangeRef.current?.(editor.getJSON());
    editor.on('update', emit);
    return () => { editor.off('update', emit); };
  }, [editor]);

  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    if (!editor) return undefined;
    onEditorRef.current?.(editor);
    return () => onEditorRef.current?.(null);
  }, [editor]);

  const cursorAnchor = useCallback((ed: Editor | null): Anchor => (
    ed ? menuPosition(ed, ed.state.selection.from, 380) : { top: 160, left: 160 }), []);

  const noAssets = () => toast('Templates can\'t include uploaded images or files.');
  const actions: ToolbarActions = {
    pickImage: noAssets,
    pickFile: noAssets,
    pickPage: () => setPicker(cursorAnchor(editor)),
    editLink: (anchor) => setLinkAt(anchor),
  };

  const onPick = (node: PickedNode) => {
    setPicker(null);
    if (editor) insertPageLink(editor, node);
  };
  const closePicker = useCallback(() => setPicker(null), []);
  const closeLink = useCallback(() => setLinkAt(null), []);

  return (
    <div className="we-shell">
      <div className="we-bar">{editor && <Toolbar editor={editor} actions={actions} />}</div>
      <EditorContent editor={editor} className="wiki-doc wiki-doc-editing" />
      <SlashMenu editor={editor} actions={actions} />
      <PageLinkMenu editor={editor} />
      {editor && linkAt && <LinkPopover editor={editor} anchor={linkAt} onClose={closeLink} />}
      {picker && (
        <PickerPopover kind="page" anchor={picker} title="Link to a page" onPick={onPick} onClose={closePicker} />
      )}
    </div>
  );
}
