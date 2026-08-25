/**
 * TagInput — chips in a text box, two modes:
 *
 * Free-text (default): tags typed freely with type-to-filter suggestions
 * drawn from tags already in use elsewhere (e.g. contact "functions").
 * Enter or comma commits the typed text as a tag.
 *
 * Options mode (`options` prop): tags come ONLY from the given
 * value/label list (e.g. a status_values vocabulary) — typing filters the
 * list, Enter commits the top suggestion, arbitrary text never commits.
 * Chips render the option's label; a value with no matching option (a
 * retired vocabulary key) still renders by its raw key and stays
 * removable, but is never suggested.
 *
 * Backspace on an empty field pops the last tag; clicking a suggestion
 * adds it straight away. Read-only (chips only, no input) when disabled.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface TagOption { value: string; label: string }

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  /** free-text mode: existing tags offered as suggestions */
  suggestions?: string[];
  /** options mode: the only committable values, shown by label */
  options?: TagOption[];
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
}

export default function TagInput({
  value, onChange, suggestions = [], options, placeholder = 'Add a tag…',
  disabled = false, maxTags = 12,
}: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const restricted = options !== undefined;
  const labelFor = useMemo(() => {
    const m = new Map((options ?? []).map((o) => [o.value, o.label]));
    return (v: string) => m.get(v) ?? v;
  }, [options]);

  const have = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (restricted) {
      return (options ?? [])
        .filter((o) => !have.has(o.value.toLowerCase()))
        .filter((o) => !q || o.label.toLowerCase().includes(q)
          || o.value.toLowerCase().includes(q))
        .slice(0, 8);
    }
    return suggestions
      .filter((s) => !have.has(s.toLowerCase()))
      .filter((s) => !q || s.toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => ({ value: s, label: s }));
  }, [restricted, options, suggestions, have, text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setText('');
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const commitValue = (v: string) => {
    if (!v || have.has(v.toLowerCase()) || value.length >= maxTags) {
      setText('');
      return;
    }
    onChange([...value, v]);
    setText('');
  };

  const commitTyped = () => {
    if (restricted) {
      // arbitrary text never commits — take the top suggestion, if any
      if (visible.length > 0) commitValue(visible[0].value);
      else setText('');
      return;
    }
    commitValue(text.trim());
  };

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTyped();
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      removeAt(value.length - 1);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setText('');
      inputRef.current?.blur();
    }
  };

  if (disabled) {
    return (
      <div className="chips">
        {value.length === 0 && <span className="chip tag">—</span>}
        {value.map((t) => <span key={t} className="chip c-blue">{labelFor(t)}</span>)}
      </div>
    );
  }

  return (
    <div className="tag-input-wrap" ref={wrapRef}>
      <div className="tag-input-box">
        {value.map((t, i) => (
          <span key={t} className="chip c-blue tag-chip">
            {labelFor(t)}
            <button type="button" aria-label={`Remove ${labelFor(t)}`}
                    onClick={() => removeAt(i)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tag-input-field"
          value={text}
          placeholder={value.length === 0 ? placeholder : ''}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onKeyDown={onKey}
          onBlur={() => { if (!restricted && text.trim()) commitValue(text.trim()); }}
        />
      </div>
      {open && visible.length > 0 && (
        <div className="combo-menu">
          {visible.map((o) => (
            <button
              key={o.value}
              type="button"
              className="kbar-item"
              onMouseDown={(e) => { e.preventDefault(); commitValue(o.value); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
