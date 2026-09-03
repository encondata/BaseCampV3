/** The app's shared toggle control (`.switch` styles live in `styles/settings.css`). */

export function Switch({ checked, onChange, disabled = false }: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
    </label>
  );
}
