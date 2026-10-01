import { useAuth } from '@portal/auth/AuthContext';
import type { UiPreferences } from '@portal/lib/api';
import { NAV_BACKGROUNDS } from '@portal/lib/settings';

const SIZES: UiPreferences['nav_size'][] = ['small', 'default', 'large', 'xlarge'];
const MODES: [UiPreferences['nav_mode'], string][] = [['expanded', 'Expanded'], ['rail', 'Icons only'], ['hidden', 'Hidden']];

export default function Me() {
  const { person, roles, preferences, updatePreferences } = useAuth();
  const set = (patch: Partial<UiPreferences>) => void updatePreferences({ ...preferences, ...patch });

  return (
    <div className="portal-page">
      <div className="eyebrow">Account</div>
      <div className="dir-head">
        <h1>{person?.display_name}</h1>
        <p>{person?.email} · {roles.join(', ')}</p>
      </div>
      <p className="page-hint">Your name, email and password come from the portal (or the Sirdar CLI for local users).</p>

      <section className="sirdar-section">
        <h2>Navigation</h2>
        <div className="sirdar-kv">
          <span>Sidebar</span>
          <div className="segmented" role="radiogroup" aria-label="Sidebar">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" role="radio" aria-checked={preferences.nav_mode === m}
                      className={preferences.nav_mode === m ? 'on' : ''} onClick={() => set({ nav_mode: m })}>{label}</button>
            ))}
          </div>
          <span>Text size</span>
          <div className="segmented" role="radiogroup" aria-label="Navigation text size">
            {SIZES.map((sz) => (
              <button key={sz} type="button" role="radio" aria-checked={preferences.nav_size === sz}
                      className={preferences.nav_size === sz ? 'on' : ''} onClick={() => set({ nav_size: sz })}>{sz}</button>
            ))}
          </div>
          <span>Background</span>
          <div className="segmented" role="radiogroup" aria-label="Navigation background">
            <button type="button" role="radio" aria-checked={preferences.nav_bg === 'default'}
                    className={preferences.nav_bg === 'default' ? 'on' : ''} onClick={() => set({ nav_bg: 'default' })}>Default</button>
            {NAV_BACKGROUNDS.map((b) => (
              <button key={b.key} type="button" role="radio" aria-checked={preferences.nav_bg === b.key}
                      className={preferences.nav_bg === b.key ? 'on' : ''} onClick={() => set({ nav_bg: b.key })}>{b.label}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="sirdar-section">
        <h2>Lists</h2>
        <div className="segmented" role="radiogroup" aria-label="List text size">
          {SIZES.map((sz) => (
            <button key={sz} type="button" role="radio" aria-checked={preferences.list_size === sz}
                    className={preferences.list_size === sz ? 'on' : ''} onClick={() => set({ list_size: sz })}>{sz}</button>
          ))}
        </div>
      </section>
    </div>
  );
}
