/**
 * InlineTextField — a text input that commits on blur/Enter instead of on
 * every keystroke, for row-level inline edits (contact org_title) where a
 * PATCH per keystroke would be wasteful and noisy in the audit trail.
 */

import { useEffect, useState } from 'react';

export default function InlineTextField({ value, onCommit, placeholder, disabled, maxWidth }: {
  value: string | null;
  onCommit: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  maxWidth?: number;
}) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);

  const commit = () => {
    const next = text.trim() || null;
    if (next !== (value ?? null)) onCommit(next);
  };

  return (
    <input
      className="org-select"
      style={{ maxWidth: maxWidth ?? 180 }}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}
