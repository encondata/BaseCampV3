/** The editor's sticky toolbar: history, block type, marks, lists,
 *  alignment, link, and inserts (image, file, table, callout, code block,
 *  collapsible section, divider, page link). Inside a table a second row
 *  adds row/column controls. */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { insertCallout, insertDetails, insertTable, type BlockActions } from './blocks';
import { Icon, type IconName } from './icons';

export interface ToolbarActions extends BlockActions {
  /** Opens the link editor under `anchor`. */
  editLink: (anchor: { top: number; left: number }) => void;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function Btn({ icon, label, shortcut, active, disabled, onClick }: {
  icon: IconName; label: string; shortcut?: string; active?: boolean; disabled?: boolean;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`we-tb-btn${active ? ' on' : ''}`}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

interface MenuItem {
  key: string;
  label: string;
  icon: IconName;
  active: boolean;
  run: () => void;
}

/** A toolbar button that opens a short menu (block type, alignment). */
function Dropdown({ label, icon, text, items }: {
  label: string; icon?: IconName; text?: string; items: MenuItem[];
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    const close = () => setPos(null);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.left });
  };

  return (
    <>
      <button ref={btnRef} type="button" className={`we-tb-btn we-tb-drop${text ? ' has-text' : ''}`}
              aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!pos}
              onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        {icon && <Icon name={icon} />}
        {text && <span className="we-tb-text">{text}</span>}
        <Icon name="chevronDown" className="we-icon we-tb-caret" />
      </button>
      {pos && (
        <div ref={menuRef} className="pop-menu we-tb-menu" role="menu" aria-label={label}
             style={{ position: 'fixed', top: pos.top, left: pos.left, right: 'auto' }}
             onMouseDown={(e) => e.preventDefault()}>
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitemradio" aria-checked={it.active}
                    className={`pop-item${it.active ? ' on' : ''}`}
                    onClick={() => { setPos(null); it.run(); }}>
              <Icon name={it.icon} />{it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const Sep = () => <span className="we-tb-sep" aria-hidden="true" />;

export default function Toolbar({ editor, actions }: { editor: Editor; actions: ToolbarActions }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      h: [1, 2, 3].find((level) => e.isActive('heading', { level })) ?? 0,
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      link: e.isActive('link'),
      table: e.isActive('table'),
      headerRow: e.isActive('tableHeader'),
    }),
  });
  const chain = () => editor.chain().focus();
  const anchorOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { top: r.bottom + 6, left: r.left };
  };

  const blockText = s.h ? `Heading ${s.h}` : s.codeBlock ? 'Code' : s.quote ? 'Quote' : 'Text';
  const blockItems: MenuItem[] = [
    { key: 'p', label: 'Text', icon: 'paragraph', active: !s.h && !s.codeBlock, run: () => chain().setParagraph().run() },
    ...([1, 2, 3] as const).map((level): MenuItem => ({
      key: `h${level}`, label: `Heading ${level}`, icon: `heading${level}` as IconName, active: s.h === level,
      run: () => chain().setHeading({ level }).run(),
    })),
    { key: 'quote', label: 'Quote', icon: 'quote', active: s.quote, run: () => chain().toggleBlockquote().run() },
    { key: 'code', label: 'Code block', icon: 'codeBlock', active: s.codeBlock, run: () => chain().toggleCodeBlock().run() },
  ];
  const alignIcon: Record<string, IconName> = {
    left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify',
  };
  const alignItems: MenuItem[] = (['left', 'center', 'right', 'justify'] as const).map((a) => ({
    key: a, label: `Align ${a}`, icon: alignIcon[a], active: s.align === a,
    run: () => chain().setTextAlign(a).run(),
  }));

  return (
    <div className="we-toolbar" role="toolbar" aria-label="Formatting">
      <div className="we-tb-row">
        <Btn icon="undo" label="Undo" shortcut={`${MOD}Z`} disabled={!s.canUndo} onClick={() => chain().undo().run()} />
        <Btn icon="redo" label="Redo" shortcut={`${MOD}Shift+Z`} disabled={!s.canRedo} onClick={() => chain().redo().run()} />
        <Sep />
        <Dropdown label="Block type" text={blockText} items={blockItems} />
        <Sep />
        <Btn icon="bold" label="Bold" shortcut={`${MOD}B`} active={s.bold} onClick={() => chain().toggleBold().run()} />
        <Btn icon="italic" label="Italic" shortcut={`${MOD}I`} active={s.italic} onClick={() => chain().toggleItalic().run()} />
        <Btn icon="underline" label="Underline" shortcut={`${MOD}U`} active={s.underline} onClick={() => chain().toggleUnderline().run()} />
        <Btn icon="strike" label="Strikethrough" shortcut={`${MOD}Shift+S`} active={s.strike} onClick={() => chain().toggleStrike().run()} />
        <Btn icon="code" label="Inline code" shortcut={`${MOD}E`} active={s.code} onClick={() => chain().toggleCode().run()} />
        <Btn icon="highlight" label="Highlight" shortcut={`${MOD}Shift+H`} active={s.highlight} onClick={() => chain().toggleHighlight().run()} />
        <Sep />
        <Btn icon="bulletList" label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()} />
        <Btn icon="orderedList" label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()} />
        <Btn icon="taskList" label="To-do list" active={s.task} onClick={() => chain().toggleTaskList().run()} />
        <Dropdown label="Alignment" icon={alignIcon[s.align]} items={alignItems} />
        <Sep />
        <Btn icon="link" label="Link" shortcut={`${MOD}K`} active={s.link}
             onClick={(e) => actions.editLink(anchorOf(e.currentTarget))} />
        <Btn icon="image" label="Image" onClick={() => actions.pickImage()} />
        <Btn icon="paperclip" label="File" onClick={() => actions.pickFile()} />
        <Btn icon="table" label="Table" active={s.table} onClick={() => insertTable(editor)} />
        <Btn icon="callout" label="Callout" onClick={() => insertCallout(editor)} />
        <Btn icon="codeBlock" label="Code block" active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()} />
        <Btn icon="details" label="Collapsible section" onClick={() => insertDetails(editor)} />
        <Btn icon="divider" label="Divider" onClick={() => chain().setHorizontalRule().run()} />
        <Btn icon="pageLink" label="Page link" onClick={() => actions.pickPage()} />
      </div>
      {s.table && (
        <div className="we-tb-row we-tb-table" role="group" aria-label="Table">
          <span className="we-tb-label">Table</span>
          <Btn icon="rowAbove" label="Add row above" onClick={() => chain().addRowBefore().run()} />
          <Btn icon="rowBelow" label="Add row below" onClick={() => chain().addRowAfter().run()} />
          <Btn icon="colLeft" label="Add column left" onClick={() => chain().addColumnBefore().run()} />
          <Btn icon="colRight" label="Add column right" onClick={() => chain().addColumnAfter().run()} />
          <Sep />
          <Btn icon="rowDelete" label="Delete row" onClick={() => chain().deleteRow().run()} />
          <Btn icon="colDelete" label="Delete column" onClick={() => chain().deleteColumn().run()} />
          <Btn icon="headerRow" label="Header row" active={s.headerRow} onClick={() => chain().toggleHeaderRow().run()} />
          <Sep />
          <Btn icon="trash" label="Delete table" onClick={() => chain().deleteTable().run()} />
        </div>
      )}
    </div>
  );
}
