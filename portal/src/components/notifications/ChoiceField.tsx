/**
 * ChoiceField — a labeled either/or setting in the house `.segmented` control
 * (buttons with aria-pressed). The notification dialogs use it for a small
 * fixed choice (Check delivery's "Which copy"). Put it in a `.pf-form` cell;
 * pass className="full" for a whole row.
 */

import { useId } from 'react';

export default function ChoiceField<K extends string>({
  label, options, value, onChange, className,
}: {
  label: string;
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (next: K) => void;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div className={className}>
      <label id={labelId}>{label}</label>
      <div className="segmented" role="group" aria-labelledby={labelId}>
        {options.map((o) => (
          <button key={o.key} type="button" className={value === o.key ? 'on' : ''}
                  aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
