/** Add, change or remove a link on the selection (⌘K, the toolbar, the
 *  selection bubble). Only the targets the shared schema keeps are
 *  accepted: web, mail and phone links, and wiki links (/n/…). */
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Icon } from './icons';
import { isAllowedHref } from './schema';

/** The href to store for what was typed, or why it can't be one. A bare
 *  domain ("example.com/x") becomes https. */
export function normalizeHref(raw: string): { href: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: 'Enter a link.' };
  let href = value;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(value)) href = `https://${value}`;
  else if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value)) href = `mailto:${value}`;
  if (/\s/.test(href) || !isAllowedHref(href)) {
    return { error: 'Use a web address (https://…), an email or phone link, or a wiki link (/n/…).' };
  }
  return { href };
}

export default function LinkPopover({ editor, anchor, onClose }: {
  editor: Editor;
  anchor: { top: number; left: number };
  onClose: () => void;
}) {
  const existing = (editor.getAttributes('link').href as string | undefined) ?? '';
  const [value, setValue] = useState(existing);
  const [error, setError] = useState('');
  const boxRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const result = normalizeHref(value);
    if ('error' in result) { setError(result.error); return; }
    const { href } = result;
    const chain = editor.chain().focus();
    if (editor.isActive('link')) {
      chain.extendMarkRange('link').setLink({ href }).run();
    } else if (editor.state.selection.empty) {
      chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
    onClose();
  };

  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  return (
    <form ref={boxRef} className="we-menu we-link-pop" style={{ top: anchor.top, left: anchor.left }}
          role="dialog" aria-label="Link" onSubmit={apply}>
      <label className="we-picker-search">
        <Icon name="link" />
        <input autoFocus value={value} placeholder="Paste or type a link" aria-label="Link address"
               aria-invalid={!!error} onChange={(e) => { setValue(e.target.value); setError(''); }}
               onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); editor.commands.focus(); } }} />
      </label>
      {error && <p className="we-link-error" role="alert">{error}</p>}
      <div className="we-link-actions">
        {existing && (
          <button type="button" className="mini-btn" onClick={remove}><Icon name="unlink" />Remove link</button>
        )}
        <button type="submit" className="btn-solid">{existing ? 'Update' : 'Add link'}</button>
      </div>
    </form>
  );
}
