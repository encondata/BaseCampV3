/** The kiosk's toggle control (`.kiosk-switch` styles live in `styles/kiosk.css`).
 *  Mirrors the portal's `.switch` in spirit (track + sliding knob) but is a
 *  plain button — the kiosk can't import the portal's `.tsx` component. */

export function Switch({ on, onChange, id, 'aria-label': ariaLabel }: {
  on: boolean;
  onChange: (on: boolean) => void;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      aria-label={ariaLabel}
      className={`kiosk-switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="kiosk-switch-knob" />
    </button>
  );
}
