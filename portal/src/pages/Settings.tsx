/**
 * Settings — fibertrace user-menu-and-account.md §6 appearance options,
 * persisted on the user's ACCOUNT (server-side): sign in anywhere and get
 * your normal display. Changes apply instantly (optimistic) and save in
 * the background.
 */

import { useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import AdminControls from '../components/settings/AdminControls';
import { Switch } from '../components/Switch';
import type { UiPreferences } from '../lib/api';
import { ACCENTS, NAV_BACKGROUNDS, NAV_MODES } from '../lib/settings';
import '../styles/settings.css';

export default function Settings() {
  const { person, roles, can, preferences, updatePreferences } = useAuth();
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');

  const update = async (patch: Partial<UiPreferences>) => {
    const next: UiPreferences = {
      ...preferences,
      ...patch,
      notif: { ...preferences.notif, ...(patch.notif ?? {}) },
    };
    const ok = await updatePreferences(next);
    setSaveState(ok ? 'saved' : 'error');
  };

  const isCustomNavBg = preferences.nav_bg.startsWith('#')
    && !NAV_BACKGROUNDS.some((b) => b.key === preferences.nav_bg);

  const notifRow = (key: keyof UiPreferences['notif'], label: string, sub: string) => (
    <div className="set-row">
      <div className="set-label"><b>{label}</b><span>{sub}</span></div>
      <Switch checked={preferences.notif[key]}
              onChange={(v) => update({ notif: { ...preferences.notif, [key]: v } })} />
    </div>
  );

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">Settings</h1>
      <p className="page-hint">
        Preferences are saved to your account — sign in on any device and the
        portal looks the way you left it.{' '}
        {saveState === 'saved' && <span className="save-state">saved</span>}
        {saveState === 'error' && (
          <span className="save-state error">could not save — changes are local only</span>
        )}
      </p>

      <div className="set-stack">
        <section className="set-section">
          <div className="set-head">
            <h3>Appearance</h3>
            <p>How the portal looks and moves, everywhere you sign in.</p>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Accent color</b>
              <span>Highlights, active states, and focus rings across the portal.</span>
            </div>
            <div className="accent-swatches">
              {ACCENTS.map((a) => (
                <button key={a.key}
                        className={`accent-sw ${preferences.accent === a.key ? 'on' : ''}`}
                        style={{ background: a.color }}
                        aria-label={`Accent: ${a.key}`}
                        title={a.key}
                        onClick={() => update({ accent: a.key })} />
              ))}
              <label
                className={`accent-sw custom ${preferences.accent.startsWith('#') ? 'on' : ''}`}
                style={preferences.accent.startsWith('#')
                  ? { background: preferences.accent } : undefined}
                title="Custom color"
              >
                <input
                  type="color"
                  value={preferences.accent.startsWith('#') ? preferences.accent : '#ffa12e'}
                  onChange={(e) => update({ accent: e.target.value })}
                  aria-label="Custom accent color"
                />
              </label>
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Theme</b>
              <span>Light paper or dark control-room for the content area.</span>
            </div>
            <div className="seg-mini">
              {(['light', 'dark'] as const).map((t) => (
                <button key={t} className={preferences.theme === t ? 'on' : ''}
                        onClick={() => update({ theme: t })}>
                  {t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Interface density</b>
              <span>Compact tightens list rows to fit more on screen.</span>
            </div>
            <div className="seg-mini">
              {(['comfortable', 'compact'] as const).map((d) => (
                <button key={d} className={preferences.density === d ? 'on' : ''}
                        onClick={() => update({ density: d })}>
                  {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>List text size</b>
              <span>Scales every list and table — pick what reads best on your screen.</span>
            </div>
            <div className="seg-mini">
              {([['small', 'Small'], ['default', 'Default'], ['large', 'Large'], ['xlarge', 'Extra large']] as const).map(([key, label]) => (
                <button key={key} className={preferences.list_size === key ? 'on' : ''}
                        onClick={() => update({ list_size: key })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="eyebrow" style={{ padding: '18px 20px 0' }}>Navigation</div>
          <div className="set-row">
            <div className="set-label">
              <b>Sidebar</b>
              <span>Collapse to an icon rail or hide it; Ctrl/⌘+B toggles from anywhere.</span>
            </div>
            <div className="seg-mini">
              {NAV_MODES.map((m) => (
                <button key={m} className={preferences.nav_mode === m ? 'on' : ''}
                        onClick={() => update({ nav_mode: m })}>
                  {m === 'expanded' ? 'Expanded' : m === 'rail' ? 'Rail' : 'Hidden'}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Sidebar background</b>
              <span>Colors the navigation panel behind every section.</span>
            </div>
            <div className="accent-swatches">
              <button
                className={`accent-sw ${preferences.nav_bg === 'default' ? 'on' : ''}`}
                style={{ background: 'radial-gradient(140% 60% at 0% 0%, #16202e 0%, #0c1117 60%)' }}
                aria-label="Sidebar background: Default"
                title="Default"
                onClick={() => update({ nav_bg: 'default' })} />
              {NAV_BACKGROUNDS.map((b) => (
                <button key={b.key}
                        className={`accent-sw ${preferences.nav_bg === b.key ? 'on' : ''}`}
                        style={{ background: b.color }}
                        aria-label={`Sidebar background: ${b.label}`}
                        title={b.label}
                        onClick={() => update({ nav_bg: b.key })} />
              ))}
              <label
                className={`accent-sw custom ${isCustomNavBg ? 'on' : ''}`}
                style={isCustomNavBg ? { background: preferences.nav_bg } : undefined}
                title="Custom color"
              >
                <input
                  type="color"
                  value={preferences.nav_bg.startsWith('#') ? preferences.nav_bg : '#1f2937'}
                  onChange={(e) => update({ nav_bg: e.target.value })}
                  aria-label="Custom sidebar background"
                />
              </label>
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Sidebar text size</b>
              <span>Scales section labels and links in the sidebar.</span>
            </div>
            <div className="seg-mini">
              {([['small', 'Small'], ['default', 'Default'], ['large', 'Large'], ['xlarge', 'Extra large']] as const).map(([key, label]) => (
                <button key={key} className={preferences.nav_size === key ? 'on' : ''}
                        onClick={() => update({ nav_size: key })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div className="set-label">
              <b>Interface motion</b>
              <span>Entrance and disclosure animations. Your OS reduced-motion setting always wins.</span>
            </div>
            <Switch checked={preferences.motion} onChange={(v) => update({ motion: v })} />
          </div>
        </section>

        <section className="set-section">
          <div className="set-head">
            <h3>Notifications</h3>
            <p>What you want to hear about. Delivery wiring lands with the notification service.</p>
          </div>
          {notifRow('critical', 'Critical incidents', 'Immediate alerts for anything move-blocking.')}
          {notifRow('email', 'Email alerts', 'Send notifications to your contact email.')}
          {notifRow('maint', 'Maintenance windows', 'Scheduled downtime and system maintenance notices.')}
          {notifRow('digest', 'Weekly digest', 'A summary of activity across your projects.')}
        </section>

        <section className="set-section">
          <div className="set-head">
            <h3>Account</h3>
            <p>Your identity in the portal.</p>
          </div>
          <div className="set-form-row">
            <div>
              <label>Display name</label>
              <input value={person?.display_name ?? ''} disabled />
            </div>
            <div>
              <label>Email</label>
              <input value={person?.email ?? ''} disabled />
            </div>
          </div>
          <p className="set-note">
            Editing your profile, email, and password arrives with account
            management. Roles: {roles.join(', ') || '—'}.
          </p>
        </section>

        {can('settings', 'change') && (
          <section className="set-section">
            <div className="set-head">
              <h3>Administration</h3>
              <p>Console-wide controls. Visible to admins only.</p>
            </div>
            <AdminControls />
          </section>
        )}
      </div>
    </div>
  );
}
