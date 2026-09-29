/** A small floating bar over selected text: bold, italic, link, highlight,
 *  inline code — and "Comment" when the page takes comments. Shown while
 *  the editor has focus and a text range is selected (not inside a code
 *  block). */
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from './icons';

interface Spot {
  top: number;
  left: number;
  marks: Record<string, boolean>;
}

const WIDTH = 196;
const COMMENT_WIDTH = 96;

function spotOf(editor: Editor, width: number): Spot | null {
  const { state, view } = editor;
  const { selection } = state;
  if (!editor.isEditable || !editor.isFocused || selection.empty || !(selection instanceof TextSelection)) return null;
  if (editor.isActive('codeBlock') || !state.doc.textBetween(selection.from, selection.to).trim()) return null;
  try {
    const a = view.coordsAtPos(selection.from);
    const b = view.coordsAtPos(selection.to, -1);
    const mid = (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2;
    const top = Math.min(a.top, b.top) - 46;
    return {
      top: top < 8 ? Math.max(a.bottom, b.bottom) + 8 : top,
      left: Math.max(8, Math.min(mid - width / 2, window.innerWidth - width - 8)),
      marks: {
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        link: editor.isActive('link'),
        highlight: editor.isActive('highlight'),
        code: editor.isActive('code'),
      },
    };
  } catch {
    return null;
  }
}

function sameSpot(a: Spot | null, b: Spot | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.top !== b.top || a.left !== b.left) return false;
  return Object.keys(a.marks).every((k) => a.marks[k] === b.marks[k]);
}

export default function SelectionBubble({ editor, onLink, onComment }: {
  editor: Editor;
  onLink: (anchor: { top: number; left: number }) => void;
  /** Comment on the selected text. */
  onComment?: () => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const shown = useRef<Spot | null>(null);
  const [pointerDown, setPointerDown] = useState(false);
  const width = onComment ? WIDTH + COMMENT_WIDTH : WIDTH;

  useEffect(() => {
    // remote changes re-run this constantly; re-render only on a real move
    const update = () => {
      const next = spotOf(editor, width);
      if (sameSpot(shown.current, next)) return;
      shown.current = next;
      setSpot(next);
    };
    const hide = () => { shown.current = null; setSpot(null); };
    // wait for the drag-select to finish before showing
    const down = () => setPointerDown(true);
    const up = () => { setPointerDown(false); update(); };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', hide);
    const dom = editor.view.dom;
    dom.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', hide);
      dom.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, [editor, width]);

  if (!spot || pointerDown) return null;
  const btn = (icon: IconName, label: string, active: boolean, run: () => void) => (
    <button type="button" className={`we-tb-btn${active ? ' on' : ''}`} aria-label={label} title={label}
            aria-pressed={active} onClick={run}>
      <Icon name={icon} />
    </button>
  );
  const chain = () => editor.chain().focus();
  return (
    <div className="we-bubble" role="toolbar" aria-label="Selected text" style={{ top: spot.top, left: spot.left }}
         onMouseDown={(e) => e.preventDefault()}>
      {btn('bold', 'Bold', spot.marks.bold, () => chain().toggleBold().run())}
      {btn('italic', 'Italic', spot.marks.italic, () => chain().toggleItalic().run())}
      {btn('link', 'Link', spot.marks.link, () => onLink({ top: spot.top + 44, left: spot.left }))}
      {btn('highlight', 'Highlight', spot.marks.highlight, () => chain().toggleHighlight().run())}
      {btn('code', 'Inline code', spot.marks.code, () => chain().toggleCode().run())}
      {onComment && (
        <button type="button" className="we-tb-btn we-bubble-comment" onClick={onComment}>
          <Icon name="comment" />Comment
        </button>
      )}
    </div>
  );
}
