/**
 * TagInput — free-text tags with type-to-filter suggestions drawn from
 * tags already in use elsewhere (e.g. contact "functions" across the
 * external directory). Enter or comma commits the typed text as a tag;
 * Backspace on an empty field pops the last tag; clicking a suggestion
 * adds it straight away. Read-only (chips only, no input) when disabled.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
}

export default function TagInput({
  value, onChange, suggestions = [], placeholder = 'Add a tag…',
  disabled = false, maxTags = 12,
}: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const have = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions
      .filter((s) => !have.has(s.toLowerCase()))
      .filter((s) => !q || s.toLowerCase().includes(q))
      .slice(0, 8);
  }, [suggestions, have, text]);

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

  const commit = (raw: string) => {
    const tag = raw.trim();
    if (!tag || have.has(tag.toLowerCase()) || value.length >= maxTags) {
      setText('');
      return;
    }
    onChange([...value, tag]);
    setText('');
  };

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(text);
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
        {value.map((t) => <span key={t} className="chip c-blue">{t}</span>)}
      </div>
    );
  }

  return (
    <div className="tag-input-wrap" ref={wrapRef}>
      <div className="tag-input-box">
        {value.map((t, i) => (
          <span key={t} className="chip c-blue tag-chip">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => removeAt(i)}>
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
          onBlur={() => { if (text.trim()) commit(text); }}
        />
      </div>
      {open && visible.length > 0 && (
        <div className="combo-menu">
          {visible.map((s) => (
            <button
              key={s}
              type="button"
              className="kbar-item"
              onMouseDown={(e) => { e.preventDefault(); commit(s); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
