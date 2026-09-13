/** The three sign-in methods as a .segmented pill group. The choice
 *  persists per browser so a kiosk left on the floor reopens on its QR. */

export type Method = 'password' | 'link' | 'move';

export const METHODS: { id: Method; label: string }[] = [
  { id: 'password', label: 'Email & password' },
  { id: 'link', label: 'Link with phone' },
  { id: 'move', label: 'Move password' },
];

const KEY = 'ss.kiosk.method';

export function readMethod(): Method {
  try {
    const v = localStorage.getItem(KEY);
    return METHODS.some((m) => m.id === v) ? (v as Method) : 'link';
  } catch {
    return 'link';
  }
}

export function storeMethod(method: Method): void {
  try {
    localStorage.setItem(KEY, method);
  } catch {
    /* per-browser convenience only */
  }
}

export default function MethodSwitch({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  return (
    <div className="segmented method-switch" role="tablist" aria-label="Sign-in method">
      {METHODS.map((m) => (
        <button key={m.id} type="button" role="tab" aria-selected={value === m.id}
                className={value === m.id ? 'on' : ''} onClick={() => onChange(m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}
