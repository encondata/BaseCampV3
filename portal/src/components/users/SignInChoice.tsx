/**
 * SignInChoice — the segmented "how do they get a password" choice shown
 * only when the server can send email: Add person and Grant portal access
 * ("Email an invite link" / "Set a temporary password") and Reset password
 * ("Email a reset link" / "Set a temporary password").
 */

export interface SignInOption<K extends string> { key: K; label: string }

export const INVITE_OPTIONS: SignInOption<'invite' | 'password'>[] = [
  { key: 'invite', label: 'Email an invite link' },
  { key: 'password', label: 'Set a temporary password' },
];

export const RESET_OPTIONS: SignInOption<'link' | 'password'>[] = [
  { key: 'link', label: 'Email a reset link' },
  { key: 'password', label: 'Set a temporary password' },
];

export function SignInChoice<K extends string>({ label, options, value, onChange, disabled }: {
  label: string;
  options: SignInOption<K>[];
  value: K;
  onChange: (next: K) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" className={value === o.key ? 'on' : ''}
                aria-pressed={value === o.key} disabled={disabled}
                onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
