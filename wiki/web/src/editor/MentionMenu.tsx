/** The "@" mention picker: typing "@" at the start of a block or after a
 *  space lists people who can view this page (`listMentionable`, as you
 *  type); Up/Down move, Enter (or a click) inserts a mention, Escape
 *  closes. Every answer feeds the person-name cache the mention node view
 *  reads. */
import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';

import { personColor } from '../lib/personColor';
import { rememberPersonNames } from '../lib/personNames';
import type { PersonRef } from '../lib/types';
import { listMentionable } from '../lib/wikiApi';
import {
  cycle, findTrigger, menuPosition, MENTION_PATTERN, useMenuKeys, useTrigger,
} from './suggest';

const DEBOUNCE_MS = 150;
const MAX_PEOPLE = 10;

type PeopleState = { status: 'idle' | 'loading' | 'done' | 'error'; people: PersonRef[] };

/** Debounced `listMentionable` while the picker is open; the newest query wins. */
function useMentionable(pageId: string, query: string, open: boolean): PeopleState {
  const [state, setState] = useState<PeopleState>({ status: 'idle', people: [] });
  const q = query.trim();
  useEffect(() => {
    if (!open) { setState({ status: 'idle', people: [] }); return undefined; }
    let live = true;
    setState((s) => ({ status: 'loading', people: s.people }));
    const timer = setTimeout(() => {
      listMentionable(pageId, q)
        .then((found) => {
          if (!live) return;
          const people = found.slice(0, MAX_PEOPLE);
          rememberPersonNames(people);
          setState({ status: 'done', people });
        })
        .catch(() => { if (live) setState({ status: 'error', people: [] }); });
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [pageId, q, open]);
  return state;
}

/** Inserts a mention of `person` (and a space after it) over `range`. */
export function insertMention(editor: Editor, person: PersonRef, range: { from: number; to: number }): void {
  rememberPersonNames([person]);
  editor.chain().focus().deleteRange(range)
    .insertContent([
      { type: 'mention', attrs: { personId: person.id, label: person.name } },
      { type: 'text', text: ' ' },
    ])
    .run();
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2)
  .map((part) => part[0]).join('').toUpperCase();

const findMention = (state: Editor['state']) => findTrigger(state, MENTION_PATTERN);

export default function MentionMenu({ editor, pageId }: { editor: Editor | null; pageId: string }) {
  const [trigger, dismiss] = useTrigger(editor, findMention);
  const query = trigger?.query.trim() ?? '';
  const state = useMentionable(pageId, query, !!trigger);
  const [active, setActive] = useState(0);

  useEffect(() => { setActive(0); }, [state.people]);

  const pick = (person: PersonRef | undefined) => {
    if (!editor || !trigger || !person) return;
    insertMention(editor, person, trigger);
  };

  useMenuKeys(editor, !!trigger, (event) => {
    const n = state.people.length;
    if (event.key === 'ArrowDown') { setActive((i) => cycle(i, 1, n)); return true; }
    if (event.key === 'ArrowUp') { setActive((i) => cycle(i, -1, n)); return true; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!n) return event.key === 'Tab';
      pick(state.people[active]);
      return true;
    }
    if (event.key === 'Escape') { dismiss(); return true; }
    return false;
  });

  if (!editor || !trigger) return null;
  const pos = menuPosition(editor, trigger.from);
  return (
    <div className="we-menu we-picker we-mention-menu" style={{ top: pos.top, left: pos.left }}
         onMouseDown={(e) => e.preventDefault()}>
      <div className="we-menu-title">Mention someone</div>
      <div role="listbox" aria-label="People" className="we-menu-list">
        {state.people.map((person, i) => (
          <div
            key={person.id}
            role="option"
            aria-selected={i === active}
            className={`we-menu-item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(person); }}
          >
            <span className="we-mention-avatar" style={{ background: personColor(person.id) }} aria-hidden="true">
              {initials(person.name)}
            </span>
            <span className="we-menu-text"><b>{person.name}</b></span>
          </div>
        ))}
        {state.status === 'done' && !state.people.length && (
          <div className="we-menu-empty">
            {query ? `No one who can view this page matches “${query}”` : 'No one else can view this page'}
          </div>
        )}
        {state.status === 'loading' && !state.people.length && <div className="we-menu-empty">Searching…</div>}
        {state.status === 'error' && <div className="we-menu-empty">People search isn't available right now</div>}
      </div>
    </div>
  );
}
