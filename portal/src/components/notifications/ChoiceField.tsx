/**
 * ChoiceField — a labeled either/or setting in the house `.segmented` control
 * (buttons with aria-pressed), with an optional muted hint under it. The
 * notification dialogs use it for a small fixed choice (Check delivery's
 * "Which copy"). Put it in a `.pf-form` cell; pass className="full" for a
 * whole row.
 */

import { useId } from 'react';

export default function ChoiceField<K extends string>({
  label, options, value, onChange, hint, disabled = false, className,
}: {
  label: string;
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (next: K) => void;
  /** A muted line under the control. */
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className={className}>
      <label id={labelId}>{label}</label>
      <div className="segmented" role="group" aria-labelledby={labelId}
           aria-describedby={hint ? hintId : undefined}>
        {options.map((o) => (
          <button key={o.key} type="button" className={value === o.key ? 'on' : ''}
                  aria-pressed={value === o.key} disabled={disabled}
                  onClick={() => onChange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
      {hint && <p id={hintId} className="cell-sub nm-hint">{hint}</p>}
    </div>
  );
}
