/** The app's shared toggle control (`.switch` styles live in `styles/settings.css`). */

export function Switch({ checked, onChange, disabled = false, label }: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label}
             onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
    </label>
  );
}
