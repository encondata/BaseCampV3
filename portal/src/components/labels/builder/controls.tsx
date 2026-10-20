/**
 * Small controls the builder's panels share: a text box that commits on
 * Enter or leaving (Escape drops the edit), the square on/off toggle of the
 * placed-fields table, and a `segmented` strip of choices (the portal's
 * pill idiom, directory.css) for display type, weight, alignment, rotation.
 */

import { useState } from 'react';
import type { KeyboardEvent } from 'react';

export function TextBox({ value, onCommit, ariaLabel, id, disabled = false, placeholder, className, multiline = false }: {
  value: string;
  onCommit: (value: string) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** A textarea (static text content); Enter still commits. */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && draft !== null) {
      e.preventDefault();
      setDraft(null);
    }
  };
  const props = {
    id, 'aria-label': ariaLabel, value: draft ?? value, disabled, placeholder, spellCheck: false,
    autoComplete: 'off', onBlur: commit, onKeyDown,
  };
  return multiline
    ? <textarea {...props} className={className ?? 'lbp-text'} rows={2} onChange={(e) => setDraft(e.target.value)} />
    : <input {...props} type="text" className={className ?? 'lbp-text'} onChange={(e) => setDraft(e.target.value)} />;
}

export function ToggleButton({ label, pressed, onToggle, disabled = false }: {
  label: string; pressed: boolean; onToggle: (next: boolean) => void; disabled?: boolean;
}) {
  return (
    <button type="button" className={`lbp-tg${pressed ? ' on' : ''}`} aria-pressed={pressed} aria-label={label}
      title={label} disabled={disabled} onClick={() => onToggle(!pressed)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
    </button>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

/** One choice of a few, as the portal's `segmented` pill strip. Each
 *  button says whether it is the one chosen (aria-pressed); with `mixed`
 *  (a selection that differs) none is. */
export function Segmented<T extends string | number>({ label, options, value, onChange, disabled = false, mixed = false }: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  mixed?: boolean;
}) {
  return (
    <div className="segmented lbp-seg" role="group" aria-label={label}>
      {options.map((o) => {
        const on = !mixed && o.value === value;
        return (
          <button key={String(o.value)} type="button" className={on ? 'on' : ''} aria-pressed={on}
            disabled={disabled || o.disabled} title={o.title} onClick={() => { if (!on) onChange(o.value); }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
