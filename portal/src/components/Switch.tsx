/** The app's shared toggle control (`.switch` styles live in `styles/settings.css`).
 *  `invalid` marks it `aria-invalid` (a form's error is about it). */

export function Switch({ checked, onChange, disabled = false, label, invalid = false }: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  invalid?: boolean;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label}
             aria-invalid={invalid || undefined} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
    </label>
  );
}
