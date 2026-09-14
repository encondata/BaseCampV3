/** Kiosk Settings — tabbed sections for Appearance, Sound, Devices,
 *  Admin, and Developer. Admin and Developer are hidden (not disabled)
 *  unless the signed-in person holds the level; every tab body is a
 *  placeholder for now. The active tab lives in the `tab` search param,
 *  so a link can deep-link straight to a section. */

import { useSearchParams } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { SETTINGS_TABS, visibleTabs, type SettingsTabId } from '../lib/settingsTabs';

const DEFAULT_TAB: SettingsTabId = 'appearance';

export default function Settings() {
  const { isAdmin, isDeveloper } = useKioskAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin, isDeveloper });
  const requested = searchParams.get('tab');
  const active = tabs.find((t) => t.id === requested) ?? tabs.find((t) => t.id === DEFAULT_TAB) ?? tabs[0];

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Settings</div>
      <h1 className="page-title">Settings</h1>
      <div className="segmented settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => {
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={on}
              className={on ? 'on' : ''}
              onClick={() => setSearchParams({ tab: t.id }, { replace: true })}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <section role="tabpanel" aria-labelledby={`settings-tab-${active.id}`}>
        <h2 className="settings-tab-title">{active.label}</h2>
        <p className="page-hint">{active.blurb}</p>
        <div className="kiosk-placeholder">
          <p>This section is not available yet.</p>
        </div>
      </section>
    </div>
  );
}
