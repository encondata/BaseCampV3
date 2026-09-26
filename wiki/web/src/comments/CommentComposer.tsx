/** Writing a comment: a plain textarea with an "@" person picker (people
 *  who can view the page, as in the editor's mention menu). A picked
 *  person goes into the text as "@Name" and is sent as an id while that
 *  "@Name" is still there. Ctrl/⌘+Enter posts, Escape closes the picker
 *  or else cancels. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { initials, useMentionable } from '../editor/MentionMenu';
import { cycle, MENTION_PATTERN } from '../editor/suggest';
import { personColor } from '../lib/personColor';
import type { CommentBodyIn, PersonRef } from '../lib/types';
import { mentionsIn } from './commentsStore';

export const MAX_COMMENT_CHARS = 5000;

interface Trigger { from: number; to: number; query: string }

/** "@name" ending at the caret, where the editor's picker would open. */
function triggerAt(value: string, caret: number): Trigger | null {
  const m = MENTION_PATTERN.exec(value.slice(0, caret));
  return m ? { from: caret - m[0].length, to: caret, query: m[1] ?? '' } : null;
}

export interface CommentComposerProps {
  pageId: string;
  /** The textarea's accessible name. */
  label: string;
  submitLabel: string;
  placeholder?: string;
  initialText?: string;
  initialMentions?: readonly PersonRef[];
  maxLength?: number;
  autoFocus?: boolean;
  /** Resolves once posted (the text then clears); a rejection keeps it. */
  onSubmit: (body: CommentBodyIn) => Promise<void>;
  onCancel?: () => void;
}

export default function CommentComposer({
  pageId, label, submitLabel, placeholder, initialText = '', initialMentions = [],
  maxLength = MAX_COMMENT_CHARS, autoFocus = false, onSubmit, onCancel,
}: CommentComposerProps) {
  const [text, setText] = useState(initialText);
  const [picked, setPicked] = useState<PersonRef[]>([...initialMentions]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const people = useMentionable(pageId, trigger?.query.trim() ?? '', !!trigger);

  useEffect(() => { setActive(0); }, [people.people]);

  useEffect(() => {
    if (!autoFocus || !box.current) return;
    const el = box.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  // after a pick, the caret goes after the inserted name
  useLayoutEffect(() => {
    if (caretAfter.current === null || !box.current) return;
    box.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  const follow = (value: string, caret: number) => {
    const found = triggerAt(value, caret);
    if (!found) dismissedAt.current = null;
    setTrigger(found && found.from !== dismissedAt.current ? found : null);
  };

  const pick = (person: PersonRef | undefined) => {
    if (!person || !trigger) return;
    const insert = `@${person.name} `;
    const next = text.slice(0, trigger.from) + insert + text.slice(trigger.to);
    caretAfter.current = trigger.from + insert.length;
    setText(next);
    setPicked((cur) => (cur.some((p) => p.id === person.id) ? cur : [...cur, person]));
    setTrigger(null);
    box.current?.focus();
  };

  const trimmed = text.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit({ text: trimmed, mentions: mentionsIn(trimmed, picked) });
      setText('');
      setPicked([]);
      setTrigger(null);
    } catch {
      /* the caller said why; the text stays to try again */
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const n = people.people.length;
    if (trigger) {
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); setActive((i) => cycle(i, 1, n)); return; }
      if (e.key === 'ArrowUp' && n) { e.preventDefault(); setActive((i) => cycle(i, -1, n)); return; }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        if (n) { e.preventDefault(); pick(people.people[active]); }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissedAt.current = trigger.from;
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="wiki-comment-composer">
      <div className="wiki-comment-input">
        <textarea
          ref={box}
          className="wiki-comment-textarea"
          aria-label={label}
          rows={3}
          value={text}
          maxLength={maxLength}
          placeholder={placeholder ?? 'Write a comment… use @ to mention someone'}
          readOnly={busy}
          onChange={(e) => {
            setText(e.target.value);
            follow(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => follow(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTrigger(null)}
          onKeyDown={onKeyDown}
        />
        {trigger && (
          <div className="we-menu we-picker we-mention-menu wiki-comment-mentions" onMouseDown={(e) => e.preventDefault()}>
            <div className="we-menu-title">Mention someone</div>
            <div role="listbox" aria-label="People" className="we-menu-list">
              {people.people.map((person, i) => (
                <div key={person.id} role="option" aria-selected={i === active}
                     className={`we-menu-item${i === active ? ' active' : ''}`}
                     onMouseEnter={() => setActive(i)}
                     onMouseDown={(e) => { e.preventDefault(); pick(person); }}>
                  <span className="we-mention-avatar" style={{ background: personColor(person.id) }} aria-hidden="true">
                    {initials(person.name)}
                  </span>
                  <span className="we-menu-text"><b>{person.name}</b></span>
                </div>
              ))}
              {people.status === 'done' && !people.people.length && (
                <div className="we-menu-empty">
                  {trigger.query.trim() ? `No one who can view this page matches “${trigger.query.trim()}”`
                    : 'No one else can view this page'}
                </div>
              )}
              {people.status === 'loading' && !people.people.length && <div className="we-menu-empty">Searching…</div>}
              {people.status === 'error' && <div className="we-menu-empty">People search isn't available right now</div>}
            </div>
          </div>
        )}
      </div>
      <div className="wiki-comment-composer-foot">
        <span className="wiki-comment-hint">Ctrl/⌘ + Enter to post</span>
        {onCancel && <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button type="button" className="btn-solid wiki-comment-post" disabled={!trimmed || busy}
                onClick={() => void submit()}>
          {busy ? 'Posting…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
