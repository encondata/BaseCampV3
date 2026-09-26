/** The "/" menu: typing a slash at the start of an empty block lists every
 *  block type; typing on filters it. Up/Down move, Enter (or a click)
 *  inserts, Escape closes. */
import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { filterBlocks, type BlockActions } from './blocks';
import { Icon } from './icons';
import {
  cycle, findTrigger, menuPosition, SLASH_PATTERN, useMenuKeys, useTrigger,
} from './suggest';

const findSlash = (state: Editor['state']) => findTrigger(state, SLASH_PATTERN, { wholeBlock: true });

export default function SlashMenu({ editor, actions }: { editor: Editor | null; actions: BlockActions }) {
  const [trigger, dismiss] = useTrigger(editor, findSlash);
  const items = useMemo(() => (trigger ? filterBlocks(trigger.query) : []), [trigger]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setActive(0); }, [trigger?.query, trigger?.from]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = (index: number) => {
    const item = items[index];
    if (!editor || !trigger || !item) return;
    item.run(editor, actions, { from: trigger.from, to: trigger.to });
  };

  useMenuKeys(editor, !!trigger, (event) => {
    if (event.key === 'ArrowDown') { setActive((i) => cycle(i, 1, items.length)); return true; }
    if (event.key === 'ArrowUp') { setActive((i) => cycle(i, -1, items.length)); return true; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!items.length) return event.key === 'Tab';
      choose(active);
      return true;
    }
    if (event.key === 'Escape') { dismiss(); return true; }
    return false;
  });

  if (!editor || !trigger) return null;
  const pos = menuPosition(editor, trigger.from);

  return (
    <div className="we-menu we-slash" style={{ top: pos.top, left: pos.left }}
         onMouseDown={(e) => e.preventDefault()}>
      <div className="we-menu-title">{trigger.query ? `Blocks matching “${trigger.query}”` : 'Insert a block'}</div>
      <div ref={listRef} role="listbox" aria-label="Insert a block" className="we-menu-list">
        {items.map((item, i) => (
          <div
            key={item.id}
            role="option"
            aria-selected={i === active}
            data-label={item.label}
            className={`we-menu-item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); choose(i); }}
          >
            <span className="we-menu-icon"><Icon name={item.icon} /></span>
            <span className="we-menu-text">
              <b>{item.label}</b>
              <span>{item.hint}</span>
            </span>
          </div>
        ))}
        {!items.length && <div className="we-menu-empty">No matching blocks</div>}
      </div>
    </div>
  );
}
